#!/usr/bin/env node
// gates/clean-artifacts.mjs — 清掉「驗證／測試過程產生、不該進 repo 的產物」的 CLI。
// commit-gate.mjs 擋下 staged 驗證垃圾時，叫你跑的就是這支（它負責「擋」，這支負責「清」）。
// 判定規則不自己養一份，一律從 commit-gate.mjs import——「被擋的」與「被清的」永遠同一套標準。
// （Flow 時代對應 flow-toolkit/clean-verify-artifacts.mjs；Constellation 首次搬遷時只搬了判定、
// 沒搬清理與 .gitignore 職責，2026-07-28 經使用者拍板補齊到同級。）
//
// 設計鐵則：
//   1) 白名單刪除——只刪「已知產物目錄／已知殘留檔樣式」，絕不盲掃。
//   2) 絕不碰交付物——source 測試檔（*.test.* / *.spec.* / *_test.* / conftest.py）與刻意留存的
//      reference data（baseline/golden/snapshot/fixture）一律保，優先於所有刪除規則。
//   3) 兩 tier 風險分層：
//        Tier A（絕對垃圾，tracked 與否都清）：產物目錄、*.log、*.trace.zip、__pycache__、*.pyc、
//          .last-run.json、debug-*、tmp-/temp-/scratch-、*.tmp。
//        Tier B（危險類別，僅 git untracked 才清）：散落的一次性截圖（screenshot-/snap-/capture-/page-*.png
//          等）、Playwright 錄影 *.webm。你 commit 過的（設計稿、demo 影片）一律不碰；查不到 git 時
//          Tier B 整批保守略過（寧漏勿誤刪）。
//   4) 預設 dry-run（只印清單），加 --apply 才真刪。dry-run 有東西 → exit 3（供呼叫端判斷「還沒清」）。
//   5) 不越界——所有目標 resolve 後 SHALL 仍在 root 內；.git／node_modules／legacy／archive／vendor 不進去。
//   6) 語意型垃圾（混在 source 裡的 mock／console.log）不歸本檔管，那是出貨階段 code review 的事。
// 用法：
//   node clean-artifacts.mjs [--root <path>] [--apply] [--gitignore]
//     省略 --root → cwd；省略 --apply → 只預覽不刪；--gitignore → 把產物 pattern 補進 <root>/.gitignore。
import { readdirSync, statSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ARTIFACT_DIRS, keepPath, isHardArtifact } from './commit-gate.mjs';

// 不進去的目錄（剪枝）：版本控制／套件／保留區（legacy／archive 只回報不刪）。
export const PRUNE = new Set(['.git', 'node_modules', 'legacy', 'archive', 'vendor', '.venv', 'venv']);

// Tier B — 危險類別（僅 git untracked 才清，避免誤殺剛加還沒 commit 的資產）。以 basename 比對。
// commit-gate 刻意不認這組（不擋圖片影片，怕誤擋使用者故意 commit 的資產），故只在本檔定義。
export const SOFT_FILE_RE = [
  /^(screenshot|snap|capture|page)([-_.].*)?\.(png|jpe?g|gif|webp)$/i, // 散落在產物目錄外的一次性截圖
  /\.webm$/i,                                                          // Playwright 錄影（retain-on-failure）
];

export const isSoftArtifact = base => !keepPath(base) && SOFT_FILE_RE.some(re => re.test(base));

// git untracked 集合（含被 .gitignore 忽略的——那些更該清）；fail-safe：非 git／git 不可用 → null
// （呼叫端對 Tier B 保守略過）。
export function gitUntracked(root) {
  try {
    const buf = execFileSync(
      'git',
      ['-C', root, 'ls-files', '--others', '-z', '--', '.', ':(exclude)node_modules', ':(exclude).git'],
      // stderr 導去 ignore：非 git repo 時 git 會噴 fatal:，那是本檔預期會遇到並靜默處理的情況
      // （回 null → Tier B 保守略過），不該把紅字漏到使用者畫面上假裝出錯了。
      { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const set = new Set();
    for (const rel of buf.toString('utf8').split('\0')) if (rel) set.add(path.resolve(root, rel));
    return set;
  } catch {
    return null;
  }
}

// ── 掃描（純函數：untracked 由呼叫端注入，可餵自訂集合，不依賴真 git）──
function dirBytes(p) {
  let total = 0;
  try {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const c = path.join(p, e.name);
      try { total += e.isDirectory() ? dirBytes(c) : statSync(c).size; } catch {}
    }
  } catch {}
  return total;
}

const fsize = p => { try { return statSync(p).size; } catch { return 0; } };

export function scan(root, untracked) {
  const ROOT = path.resolve(root);
  const inRoot = p => { const r = path.resolve(p); return r === ROOT || r.startsWith(ROOT + path.sep); };
  const dirs = [];  // 待刪目錄 {path, bytes}
  const files = []; // 待刪檔案 {path, bytes, tier}
  (function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (!inRoot(full)) continue;
      if (e.isDirectory()) {
        if (PRUNE.has(e.name)) continue;
        if (ARTIFACT_DIRS.has(e.name)) { dirs.push({ path: full, bytes: dirBytes(full) }); continue; } // 不再下探
        walk(full);
      } else if (e.isFile()) {
        if (isHardArtifact(e.name)) files.push({ path: full, bytes: fsize(full), tier: 'A' });
        else if (untracked && untracked.has(path.resolve(full)) && isSoftArtifact(e.name))
          files.push({ path: full, bytes: fsize(full), tier: 'B' });
      }
    }
  })(ROOT);
  return { dirs, files };
}

// ── .gitignore 冪等 managed block ──
const GITIGNORE_BLOCK = [
  '# >>> constellation-verify-artifacts (managed by gates/clean-artifacts.mjs) >>>',
  'test-results/', 'playwright-report/', '.playwright/',
  '.playwright-mcp/', 'playwright-mcp-output/',
  'coverage/', '.nyc_output/', 'htmlcov/',
  '.pytest_cache/', '__pycache__/',
  '*.log', '.last-run.json', '*.trace.zip', '*.tmp',
  '# <<< constellation-verify-artifacts <<<',
].join('\n');

function ensureGitignore(root) {
  const gi = path.join(root, '.gitignore');
  const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  const re = /# >>> constellation-verify-artifacts[\s\S]*?# <<< constellation-verify-artifacts <<<\n?/;
  const next = re.test(cur)
    ? cur.replace(re, GITIGNORE_BLOCK + '\n')
    : (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + GITIGNORE_BLOCK + '\n';
  if (next !== cur) { writeFileSync(gi, next, 'utf8'); return true; }
  return false;
}

// ── CLI（只在直接執行時跑；被 import 時不執行）──
const isMain = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const flag = n => argv.includes(n);
  const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const ROOT = path.resolve(val('--root', process.cwd()));
  const APPLY = flag('--apply');
  const DO_GITIGNORE = flag('--gitignore');

  if (!existsSync(ROOT)) { console.error(`root 不存在：${ROOT}`); process.exit(1); }

  const untracked = gitUntracked(ROOT);
  const { dirs, files } = scan(ROOT, untracked);

  const rel = p => path.relative(ROOT, p) || '.';
  const fmt = b => (b > 1 << 20 ? (b / (1 << 20)).toFixed(1) + 'MB' : b > 1023 ? (b / 1024).toFixed(0) + 'KB' : b + 'B');
  const totalBytes = [...dirs, ...files].reduce((s, x) => s + x.bytes, 0);
  const totalCount = dirs.length + files.length;

  console.log(`Constellation 清驗證產物 — root: ${ROOT}`);
  console.log(`模式：${APPLY ? 'APPLY（真刪）' : 'dry-run（只預覽，加 --apply 才刪）'}`);
  if (untracked === null) console.log('· 非 git repo 或 git 不可用：Tier B（圖／影片等危險類別）保守略過，只清 Tier A。');
  if (!totalCount) {
    console.log('✓ 沒有驗證產物可清。');
  } else {
    for (const d of dirs) console.log(`  [dir]  ${rel(d.path)}/  (${fmt(d.bytes)})`);
    for (const f of files) console.log(`  [${f.tier}]    ${rel(f.path)}  (${fmt(f.bytes)})`);
    console.log(`合計 ${totalCount} 項、約 ${fmt(totalBytes)}。（dir/A＝絕對垃圾；B＝untracked 才清的危險類別）`);
  }

  if (APPLY) {
    let done = 0;
    for (const x of [...dirs, ...files]) {
      try { rmSync(x.path, { recursive: true, force: true }); done++; }
      catch (e) { console.error(`  ✗ 刪不掉 ${rel(x.path)}：${e.message}`); }
    }
    if (totalCount) console.log(`✓ 已清 ${done}/${totalCount} 項。`);
  }

  if (DO_GITIGNORE) {
    const changed = ensureGitignore(ROOT);
    console.log(changed ? '✓ .gitignore 已補上 constellation-verify-artifacts 區塊。' : '· .gitignore 已含該區塊（未動）。');
  }

  // 給呼叫端判斷：dry-run 但有東西 → exit 3「還沒清」；其餘 0。
  process.exit(!APPLY && totalCount ? 3 : 0);
}
