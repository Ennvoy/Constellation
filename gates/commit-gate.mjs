#!/usr/bin/env node
// gates/commit-gate.mjs — Constellation commit 守門（PreToolUse on Bash|PowerShell）。
// 從 Flow flow-commit-gate.mjs（+ commit-gate-core.mjs）搬入並去 Flow 化，攔 `git commit`，保留三道
// 核心確定性防護：
//   閘門〇「secrets 不進歷史」：staged 含 .env/私鑰類檔案 → 擋下，先移出 staging＋補 .gitignore。
//   閘門一「先清、再 commit」：staged 含驗證垃圾（測試/驗證過程產物，含 .playwright-mcp 的 MCP 殘留）→ 擋下。
//   閘門二「done 票稽核」：staged 的票檔若把 status 設為 done，驗其最新證據筆簽章（新鮮度放寬 7 天，
//     其餘與關票刷卡機同一套驗簽邏輯）——堵「用 shell 指令繞過關票刷卡機直接改檔＋git add」這條旁門，
//     關票刷卡機只在 Edit/Write/MultiEdit/apply_patch 當下擋，commit 這關再兜底一次。
// 另補「模型端繞過 pre-commit」防線：命令帶 --no-verify/-n 或改向 -c core.hooksPath → 擋下（human 在終端機
// 自己打的不過本 hook，--no-verify 對人仍是 documented 逃生門、reflog 可稽核）。
// `--amend` 不豁免：三道閘門照常判斷當下 staged 內容。
// repo root 一律用 `git rev-parse --show-toplevel`（在 cwd 下跑）解析，失敗才 fallback 用 cwd 本身——
// `.constellation` 存在性偵測、staged 檔案清單、done 票稽核全部基於這個 root，子目錄開 commit 也準。
// 設計鐵則：fail-open（解析不出 / 非 git commit / 非 Constellation 專案 / git 或例外 → 一律放行，絕不誤擋）。
//
// ── 去 Flow 化紀錄（供整合者核對，勿在後續同步流程中復原以下行為）──
//   1) 原檔第三道閘門「先標、再 commit」（比對 commit message 點名的 flow task 是否已在 .flow ledger 標
//      delivered，依賴 flow-toolkit/statelib.mjs 與 flow-state.mjs）已整支剝除，不搬。Constellation 的
//      對應防護落在本檔「done 票稽核」＋獨立的「關票刷卡機」（gates/close-gate.mjs，票標 done 時檢查
//      驗證證據存在且新鮮），兩層責任分開：close-gate 管「改檔當下」、commit-gate 管「進歷史前兜底」。
//   2) 原本 secrets／驗證垃圾判定抽在共用檔 commit-gate-core.mjs（供 git 原生 pre-commit 對應檔
//      flow-precommit.mjs 共用），故本檔內聯全部判定邏輯，改為單檔自足，不再依賴外部 core 檔。
//      【2026-07-28 補】首次搬遷時連「原生 pre-commit 對應檔」也一併未搬，導致本檔只攔得到 Claude Code
//      發起的 commit，人在終端機手打的 commit 無人看管。Flow 退役後該缺口曝光，經使用者拍板補上：
//      不另立執行體，改在本檔加 `--precommit` 入口（見下方 runPrecommit），由 gates/precommit-install.mjs
//      冪等裝進 .git/hooks/pre-commit。兩條呼叫路徑共用同一組判定函式，杜絕規則漂移。
//   3) 「驗證垃圾」白名單原本 import 自 flow-toolkit/clean-verify-artifacts.mjs（該檔另兼 CLI 清理／
//      補 .gitignore 職責）。本檔只內聯 isCommitBlockableArtifact 判定所需的最小規則集（Tier A 絕對垃圾
//      檔名＋已知產物目錄清單），不認 Tier B（散落截圖／影片），避免誤擋使用者故意 commit 的資產。
//      【2026-07-28 補】當初未搬的「清理／補 .gitignore」職責已補齊為 gates/clean-artifacts.mjs，
//      並反向 import 本檔 export 的規則（單向依賴：本檔仍不 import 任何外部檔）；擋下時的建議動作
//      相應改為指向該 CLI。
//   4) 生效範圍門檻由「.flow 存在」改為「.constellation 存在」——僅在已採用 Constellation 工作流的專案
//      生效，非本工作流專案不受影響（與原檔「非 flow 專案放行」同一設計精神，只是換了目錄名）。
//
// R1 證據防偽（done 票稽核用）：與 gates/verify-runner.mjs／gates/close-gate.mjs 的簽章邏輯**逐字元一致
// 鏡像**（SECRET_PATH／ticketRelPath／FIELD_SEP／computeSignature／repoRootToken，以及簽章涵蓋欄位），
// 三檔各自內聯一份、不共用 import——安全閘門不依賴另一支腳本的存在／版本；改一份要同步改另兩份。
// 與另外兩檔的差異僅止於「新鮮度窗口」：關票當下 24 小時、commit 稽核放寬到 7 天（票可能關了幾天
// 才真的 commit），驗簽核心邏輯完全相同。
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 清理 CLI 的絕對路徑（由本檔實際所在目錄推導，不受呼叫時 cwd 影響）——擋下驗證垃圾時指路用。
const CLEAN_CLI = join(dirname(fileURLToPath(import.meta.url)), 'clean-artifacts.mjs');

const exit0 = () => process.exit(0);
const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

const PASS = { block: false };
const BLOCK = msg => ({ block: true, message: msg });

// 本檔邏輯抽成 commitGateCheck(input) → { block, message }，供未來若把多支 PreToolUse 閘門合併成單一
// dispatcher 時直接 import 呼叫；也保留獨立 main() 讓本檔仍可單獨當 hook 跑（測試/相容）。
// **只有直接執行本檔時才掛 stdin/main**——被其他程式 import 時不可自動跑，否則會搶先 exit 短路呼叫端。
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.includes('--precommit')) {
    // git 原生 pre-commit 呼叫路徑（gates/precommit-install.mjs 裝進 .git/hooks/pre-commit）。
    // 延到 nextTick 才跑：本入口位在模組頂部，下方的 const（ARTIFACT_DIRS/TICKET_PATH_RE…）尚在 TDZ，
    // 同步執行會 ReferenceError。stdin 那條路徑靠事件非同步天然避開，這條得自己延。
    process.nextTick(runPrecommit);
  } else {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('error', () => process.exit(0));
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', () => {
      let input;
      try { input = JSON.parse(stripBom(raw).trim() || '{}'); } catch { return exit0(); }
      let r; try { r = commitGateCheck(input); } catch { r = null; }   // fail-open
      if (r && r.block) { process.stderr.write(String(r.message || '') + '\n'); process.exit(2); }
      exit0();
    });
  }
}

// ── git 原生 pre-commit 兜底（--precommit）──
// 攔的是 PreToolUse 攔不到的整批繞法：使用者在終端機手打 commit／子行程／npm script／release 腳本／
// MCP run_code。無 stdin JSON、無 command 字串，cwd＝工作樹根。
// 與 PreToolUse 路徑的差異只有兩點：① 沒有 command 可判，故「--no-verify/-n 繞過」那道不適用（在這條
// 路徑上 --no-verify 是 git 原生逃生門，人為使用且 reflog 可稽核）；② 其餘三道閘門完全共用同一組函式。
// （註：Flow 當年的 pre-commit 只跑得動兩道——它第三道要比對 commit message 點名的 task，pre-commit
// 階段拿不到 message。Constellation 第三道是「done 票稽核」，只看 staged 內容，故這裡三道全跑。）
// 設計鐵則：fail-open——非 Constellation 專案／取不到 staged／任何例外一律 exit 0 放行，
// git commit 絕不因 hook bug 卡死。真要跳過用 git 原生 `git commit --no-verify`。
function runPrecommit() {
  try {
    const root = resolveRepoRoot(process.cwd());
    if (!existsSync(join(root, '.constellation'))) return exit0(); // 非 Constellation 專案

    const staged = stagedFiles(root); // 取不到＝null＝三道全 fail-open
    const reason = secretsReason(root, staged) || artifactsReason(staged) || doneTicketAuditReason(root, staged);
    if (reason) {
      process.stderr.write(reason + '\n  （這是 Constellation 的 git pre-commit 兜底；真要跳過：git commit --no-verify）\n');
      process.exit(1);
    }
  } catch { /* fail-open：任何例外都放行，不卡死 commit */ }
  exit0();
}

// ── repo root 解析（新增）：git rev-parse --show-toplevel，失敗 fallback cwd ──
function resolveRepoRoot(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { maxBuffer: 1 << 20 })
      .toString('utf8').trim();
    if (out) return out;
  } catch {} // 非 git repo／git 不存在等 → fallback cwd，維持 fail-open 精神
  return cwd;
}

// ── 內聯：R1 簽章（與 verify-runner.mjs／close-gate.mjs 鏡像，見檔頭說明）──
const SECRET_PATH = join(homedir(), '.constellation', 'secret');

function readSecret() {
  try {
    const s = readFileSync(SECRET_PATH, 'utf8').trim();
    return s || null;
  } catch {
    return null;
  }
}

function ticketRelPath(p) {
  const norm = String(p).replace(/\\/g, '/');
  const m = norm.match(/\.constellation\/tickets\/[^/]+\.md$/i);
  return m ? m[0] : norm;
}

function repoRootToken(cwd) {
  return resolve(cwd).toLowerCase().replace(/\\/g, '/');
}

const FIELD_SEP = '\u0001';
function computeSignature(secret, ts, relPath, commandsJoined, lastLine, repoRoot) {
  const payload = [ts, relPath, commandsJoined, lastLine, repoRoot].join(FIELD_SEP);
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function safeHexEqual(a, b) {
  try {
    const ba = Buffer.from(String(a), 'hex');
    const bb = Buffer.from(String(b), 'hex');
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

const EVIDENCE_HEADING_RE = /^##\s*驗證證據.*$/m;
function evidenceSection(content) {
  const m = content.match(EVIDENCE_HEADING_RE);
  if (!m) return '';
  const after = m.index + m[0].length;
  const rest = content.slice(after);
  const next = rest.match(/\n##\s/);
  return next ? rest.slice(0, next.index) : rest;
}

function splitEntries(section) {
  const lines = section.split(/\r?\n/);
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^-\s*\*\*[^*]+\*\*\s*$/.test(lines[i])) starts.push(i);
  }
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const begin = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
    out.push(lines.slice(begin, end));
  }
  return out;
}

function findLastOutputLine(contentLines, lastCmdIdx) {
  if (lastCmdIdx < 0) return '';
  let idx = lastCmdIdx + 1;
  if (idx < contentLines.length && /^ {4}\(.*\)\s*$/.test(contentLines[idx])) idx++;
  if (idx < contentLines.length && /^ {4}```\s*$/.test(contentLines[idx])) {
    let j = idx + 1;
    const block = [];
    while (j < contentLines.length && !/^ {4}```\s*$/.test(contentLines[j])) {
      block.push(contentLines[j]);
      j++;
    }
    for (let k = block.length - 1; k >= 0; k--) {
      const rawLine = block[k].startsWith('    ') ? block[k].slice(4) : block[k];
      if (rawLine.trim() !== '') return rawLine;
    }
  }
  return '';
}

const COMMAND_LINE_RE = /^\s*-\s*`(.+)`（exit\s*-?\d+）\s*$/;
const SIG_LINE_RE = /^\s*-\s*sig:\s*(\S+)\s*$/;

function parseEntry(linesArr) {
  const tsMatch = linesArr[0] && linesArr[0].match(/^-\s*\*\*([^*]+)\*\*\s*$/);
  const ts = tsMatch ? tsMatch[1].trim() : '';

  let sigIdx = -1, sig = null;
  for (let i = 0; i < linesArr.length; i++) {
    const m = linesArr[i].match(SIG_LINE_RE);
    if (m) { sigIdx = i; sig = m[1]; }
  }
  const contentLines = sigIdx >= 0 ? linesArr.slice(0, sigIdx) : linesArr.slice();

  const cmds = [];
  let lastCmdIdx = -1;
  for (let i = 0; i < contentLines.length; i++) {
    const m = contentLines[i].match(COMMAND_LINE_RE);
    if (m) { cmds.push(m[1]); lastCmdIdx = i; }
  }

  return {
    ts,
    sig,
    commandsJoined: cmds.join('\n'),
    lastLine: findLastOutputLine(contentLines, lastCmdIdx),
  };
}

function latestEntry(section) {
  let best = null, bestTs = -Infinity;
  for (const g of splitEntries(section)) {
    const e = parseEntry(g);
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) continue;
    if (t > bestTs) { bestTs = t; best = e; }
  }
  return best;
}

// done 票稽核用新鮮度窗口：7 天（比關票當下的 24 小時寬——票可能關了幾天才真的 commit）。
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

// 驗某張 done 票的最新證據筆是否簽章核對通過且在 7 天新鮮期內。root＝repo 根（resolveRepoRoot 結果），
// relFsPath＝該票相對 root 的路徑（git 給的 staged 路徑，天生就是這個格式）。
function verifyTicketEvidence(content, relFsPath, root) {
  const secret = readSecret();
  if (!secret) return false; // fail-closed：沒有 secret 一律視為未過關

  const section = evidenceSection(content);
  const entry = section ? latestEntry(section) : null;
  if (!entry) return false;

  const now = Date.now();
  const t = Date.parse(entry.ts);
  const fresh = !Number.isNaN(t) && (now - t <= SEVEN_DAYS_MS) && (now - t >= -CLOCK_SKEW_MS);
  if (!fresh) return false;

  if (!entry.sig || entry.sig === 'unsigned') return false;

  const relPath = ticketRelPath(relFsPath);
  const repoRoot = repoRootToken(root);
  const expected = computeSignature(secret, entry.ts, relPath, entry.commandsJoined, entry.lastLine, repoRoot);
  return safeHexEqual(expected, entry.sig);
}

// ── 內聯：驗證垃圾白名單判定（原 flow-toolkit/clean-verify-artifacts.mjs 的最小子集，見去 Flow 化紀錄③）──
// 只認 Tier A（絕對垃圾）＋已知產物目錄；不含原檔的 Tier B（散落截圖/影片，需另查 git untracked 才清），
// 避免在 commit-gate 這種輕量判定裡誤擋使用者故意 commit 的資產。
// 這組規則對外 export：gates/clean-artifacts.mjs 單向 import 沿用，確保「擋下的」與「清掉的」永遠同一套
// 標準、不會各養一份而漂移。本檔仍不 import 任何外部檔（單檔自足的安全閘門紀律不變，見去 Flow 化紀錄②）。
export const ARTIFACT_DIRS = new Set([
  'test-results', 'playwright-report', '.playwright',     // @playwright/test
  '.playwright-mcp', 'playwright-mcp-output',             // @playwright/mcp 操作殘留
  'coverage', '.nyc_output', 'htmlcov',                   // 覆蓋率
  '.pytest_cache', '__pycache__',                         // pytest / Python
]);
export const HARD_FILE_RE = [
  /\.log$/i,
  /^\.last-run\.json$/i,
  /\.trace\.zip$/i,
  /\.pyc$/i,
  /^debug[-.].*\.(png|jpe?g|gif|json|txt|html)$/i,
  /^(tmp|temp|scratch)[-.].*/i,
  /\.tmp$/i,
];
// 絕不誤判：source 測試檔＋刻意留存的 reference data（交付物）優先於上面所有規則。
export const KEEP_RE = [
  /\.(test|spec)\.[cm]?[jt]sx?$/i, /_test\.[a-z]+$/i, /(^|[/\\])conftest\.py$/i,
  /baseline/i, /golden/i, /snapshot/i, /\.fixture\./i,
];
// 歧義命名前綴（tmp-/temp-/scratch-/debug-）＋已知原始碼副檔名＝多半是正常檔非垃圾，排除掉，
// 避免誤擋 src/temp-storage.ts、debug-config.json 這類正常原始碼。
const AMBIGUOUS_PREFIX_RE = /^(tmp|temp|scratch|debug)[-.]/i;
const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|h|hpp|cpp|cc|cs|swift|kt|scala|css|scss|less|vue|svelte|json|jsonc|toml|md|mdx|html?|sql|sh|graphql|gql|proto)$/i;

export const keepPath = base => KEEP_RE.some(re => re.test(base));
export const underArtifactDir = relpath => relpath.split(/[/\\]/).some(seg => ARTIFACT_DIRS.has(seg));
export const isHardArtifact = base => {
  if (keepPath(base) || !HARD_FILE_RE.some(re => re.test(base))) return false;
  if (AMBIGUOUS_PREFIX_RE.test(base) && SOURCE_EXT_RE.test(base)) return false;
  return true;
};
export function isCommitBlockableArtifact(relpath) {
  const base = relpath.split(/[/\\]/).pop() || relpath;
  if (keepPath(base)) return false;
  return underArtifactDir(relpath) || isHardArtifact(base);
}

// ── 內聯：staged 清單 + 閘門〇（secrets）+ 閘門一（驗證垃圾）+ 閘門二（done 票稽核）判定 ──
// 全部基於 root（resolveRepoRoot 的結果），不是原始 cwd——子目錄開 commit 一樣準。
function stagedFiles(root) {
  try {
    return execFileSync('git', ['-C', root, 'diff', '--cached', '--name-only', '-z'], { maxBuffer: 1 << 26 })
      .toString('utf8').split('\0').filter(Boolean);
  } catch { return null; } // 取不到＝fail-open，三道檔案閘門都放行
}

// 檔名白名單式偵測（確定性、近零額外 IO）；樣板（*.example 等）與公鑰放行。
// .npmrc/.pypirc 常見且多半只有 registry 設定 → 只在 staged 內容真含 token/password 才擋（讀 staged 版本）。
function secretsReason(root, staged) {
  if (!staged) return null;
  const SECRET_RE = [
    /(^|\/)\.env(\.[^/]+)?$/i,                       // .env / .env.local / .env.production…
    /(^|\/)[^/]+\.env$/i,                            // production.env / prod.env / dev.env（無前導點的 dotenv 變體；*.env.example 由 SECRET_OK_RE 豁免）
    /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.[^/]*)?$/i,  // SSH 私鑰
    /\.(pem|p12|pfx|keystore|jks|key)$/i,            // 憑證/金鑰容器
    /(^|\/)(service[-_]account[^/]*|credentials|gcp[-_]?key|firebase[-_]adminsdk[^/]*)\.json$/i, // 雲端 service account 金鑰
  ];
  const SECRET_OK_RE = /\.(example|sample|template|dist|pub)$/i;
  const secrets = staged.filter((p) => !SECRET_OK_RE.test(p) && SECRET_RE.some((re) => re.test(p)));
  const TOKENY_RE = /(^|\/)\.(npmrc|pypirc)$/i;
  for (const p of staged.filter((q) => TOKENY_RE.test(q))) {
    try {
      const body = execFileSync('git', ['-C', root, 'show', ':' + p], { maxBuffer: 1 << 20 }).toString('utf8');
      // 只在帶「真正字面值」時擋——排除 env 變數引用（${VAR}/$VAR，npm 官方推薦的安全寫法），否則誤擋乾淨 .npmrc。
      if (/_authToken\s*=\s*(?!\$\{|\$[A-Za-z_])['"]?\S/i.test(body) || /password\s*[=:]\s*(?!\$\{|\$[A-Za-z_])['"]?\S/i.test(body)) secrets.push(p);
    } catch {} // 讀不到 staged 內容 → fail-open（純 registry 設定不誤擋）
  }
  if (!secrets.length) return null;
  return [
    'Constellation commit 守門：擋下 commit —— staged 含 secrets 類檔案（一進歷史就收不回）：',
    ...secrets.slice(0, 10).map((p) => '    ' + p),
    secrets.length > 10 ? `    …還有 ${secrets.length - 10} 項` : '',
    '  先移出 staging 並補 .gitignore：',
    ...secrets.slice(0, 10).map((p) => `    git restore --staged "${p}"`),
    '  真要進 repo 的樣板請改名 *.example（如 .env.example，填假值）。別把真 secret commit 進來繞過本閘門。',
  ].filter(Boolean).join('\n');
}

// staged 裡有驗證垃圾（Tier A 產物 + 產物目錄，含 .playwright-mcp 的 MCP 殘留）→ 擋下叫先清。
function artifactsReason(staged) {
  const trash = (staged || []).filter((p) => isCommitBlockableArtifact(p));
  if (!trash.length) return null;
  const show = trash.slice(0, 10).map((p) => '    ' + p).join('\n');
  const more = trash.length > 10 ? `\n    …還有 ${trash.length - 10} 項` : '';
  return [
    'Constellation commit 守門：擋下 commit —— 這些「驗證垃圾」已被 git add 進 staging，會污染交付 diff：',
    show + more,
    '  多半是測試／驗證跑出的暫存產物、非交付內容。兩步處理：',
    '  ① 移出 staging：',
    ...trash.slice(0, 10).map((p) => `       git restore --staged "${p}"`),
    '  ② 清掉檔案本身並補 .gitignore（不加 --apply 只預覽要刪什麼，確認後再加）：',
    `       node "${CLEAN_CLI}"`,
    `       node "${CLEAN_CLI}" --apply --gitignore`,
    '  別手改繞過本閘門。',
  ].join('\n');
}

const TICKET_PATH_RE = /(^|[\\/])\.constellation[\\/]tickets[\\/][^\\/]+\.md$/i;
const STATUS_DONE_RE = /^\s*status\s*:\s*done\s*(?:#.*)?$/im;

// staged 裡標 done 的票，逐張驗證據簽章——讀 staged 版本內容（git show :path），失敗才 fallback 磁碟
// （例如檔案已從 index 移除但還在工作區這種邊緣狀況，寧可再試一次也不要 fail-open 漏掉稽核）。
function doneTicketAuditReason(root, staged) {
  if (!staged) return null;
  const ticketPaths = staged.filter((p) => TICKET_PATH_RE.test(p));
  if (!ticketPaths.length) return null;

  const failing = [];
  for (const p of ticketPaths) {
    let content = null;
    try {
      content = execFileSync('git', ['-C', root, 'show', ':' + p], { maxBuffer: 1 << 24 }).toString('utf8');
    } catch {
      try { content = readFileSync(join(root, p), 'utf8'); } catch { content = null; }
    }
    if (content == null) continue; // 兩邊都讀不到 → 跳過（fail-open，不誤擋不存在/已刪的檔案）
    content = stripBom(content);
    if (!STATUS_DONE_RE.test(content)) continue; // 這次 staged 內容沒把它設 done，不必稽核
    if (!verifyTicketEvidence(content, p, root)) failing.push(p);
  }
  if (!failing.length) return null;
  return [
    'Constellation commit 守門：擋下 commit —— staged 的 done 票證據驗簽失敗——可能是繞過刷卡機直接改檔；請跑 verify-runner 重新取證再 commit：',
    ...failing.map((p) => '    ' + p),
  ].join('\n');
}

// 純判定（不碰 exit/stderr）。呼叫端負責 fail-open（try-catch）與輸出。
export function commitGateCheck(input) {
  const tool = input.tool_name ?? input.toolName ?? '';
  if (tool !== 'Bash' && tool !== 'PowerShell') return PASS;
  const ti = input.tool_input ?? input.toolInput ?? {};
  const cmd = String(ti.command ?? '');
  // 只攔真正的 commit；放行非 commit / 唯讀 git（--amend 不豁免，見檔頭）。
  // (?!-) 排除 commit-graph/commit-tree 這類非提交子命令、(?<![=-]) 排除 --grep=commit／分支名 fix-commit
  // 這類唯讀語境，免得誤攔。
  if (!/\bgit\b[^\n]*(?<![=-])\bcommit\b(?!-)/.test(cmd)) return PASS;

  const cwd = input.cwd ?? process.cwd();
  const root = resolveRepoRoot(cwd); // R9：一律用 git rev-parse --show-toplevel 解析、失敗 fallback cwd
  if (!existsSync(join(root, '.constellation'))) return PASS; // 非 Constellation 專案

  // ── 補堵「繞過 pre-commit 兜底」的旗標 ──
  // 只挖「-m/-F 的值」（含 here-string 與雙引號轉義），再去掉殘餘引號「字元」（非內容）：
  // -m\s*（而非 \s+）同時吃緊湊寫法 `-m"msg"`/`-mmsg`（無空白），否則訊息不被挖除＝假阻擋。
  //   ① message 內文含 --no-verify 隨值挖掉＝不誤擋；② 被引號包的旗標（git commit "--no-verify"）去引號後仍測得到＝不漏擋。
  const cmdFlags = cmd
    .replace(/-m\s*@(['"])[\s\S]*?\1@/g, ' ')                 // PowerShell here-string message
    .replace(/-m\s*"(?:\\.|[^"\\])*"/g, ' ')                  // 雙引號 message（吞轉義 \" 不提前收尾）
    .replace(/-m\s*'[^']*'/g, ' ')                            // 單引號 message（POSIX 無轉義）
    .replace(/-F\s+\S+/g, ' ')                                // -F <file>
    .replace(/['"]/g, ' ');                                   // 去殘餘引號字元（"--no-verify" → --no-verify）
  // --no-verify（含短式 -n 與 bundle 含 n，如 -an）＋改向 core.hooksPath（-c 旗標形／大小寫不敏感／git config 子命令形持久改向）
  const noVerify = /(^|\s)--no-verify(\s|$)/.test(cmdFlags) || /(^|\s)-[a-z]*n[a-z]*(\s|$)/.test(cmdFlags);
  const hooksPathBypass = /-c\s+core\.hooksPath\b/i.test(cmdFlags) || /\bconfig\b[^\n]*\bcore\.hooksPath\b/i.test(cmdFlags);
  if (noVerify || hooksPathBypass) {
    return BLOCK([
      'Constellation commit 守門：擋下 commit —— 命令帶了 --no-verify/-n 或改向 core.hooksPath（會繞過 pre-commit 兜底）。',
      '  secrets／驗證垃圾防護要靠 pre-commit 兜住整批繞法，別在自動流程裡關掉它（-n 是 --no-verify 短式、git config core.hooksPath 持久改向同理）。',
      '  真有正當理由跳過（例如 hook 本身壞了）→ 回報使用者由人拍板，別自行繞過。',
    ].join('\n'));
  }

  // ── 三道閘門 ──
  const staged = stagedFiles(root); // 取一次，三道共用；取不到＝null＝三道 fail-open
  const secret = secretsReason(root, staged);
  if (secret) return BLOCK(secret);
  const artifact = artifactsReason(staged);
  if (artifact) return BLOCK(artifact);
  const doneAudit = doneTicketAuditReason(root, staged);
  if (doneAudit) return BLOCK(doneAudit);

  return PASS;
}
