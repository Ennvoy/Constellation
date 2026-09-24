#!/usr/bin/env node
// gates/commit-gate.mjs — Constellation commit 守門（PreToolUse on Bash|PowerShell）。
// 從 Flow flow-commit-gate.mjs（+ commit-gate-core.mjs）搬入並去 Flow 化，攔 `git commit`，保留三道
// 核心確定性防護：
//   閘門〇「secrets 不進歷史」：staged 含 .env/私鑰類檔案 → 擋下，先移出 staging＋補 .gitignore。
//   閘門一「先清、再 commit」：staged 含驗證垃圾（測試/驗證過程產物，含 .playwright-mcp 的 MCP 殘留）→ 擋下。
//   閘門二「done 票稽核」：staged 的票檔若把 status 設為 done，驗其最新證據筆簽章（新鮮度放寬 7 天，
//     其餘與關票刷卡機同一套驗簽邏輯）——堵「用 shell 指令繞過關票刷卡機直接改檔＋git add」這條旁門，
//     關票刷卡機只在 Edit/Write/apply_patch 當下擋，commit 這關再兜底一次。
// 另補「模型端繞過 pre-commit」防線：commit 那一段命令帶 --no-verify/-n，或整條指令改向 -c core.hooksPath
// → 擋下（human 在終端機自己打的不過本 hook，--no-verify 對人仍是 documented 逃生門、reflog 可稽核）。
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
//      首次搬遷時連「原生 pre-commit 對應檔」也一併未搬，導致本檔只攔得到 Claude Code
//      發起的 commit，人在終端機手打的 commit 無人看管。Flow 退役後該缺口曝光，經使用者拍板補上：
//      不另立執行體，改在本檔加 `--precommit` 入口（見下方 runPrecommit），由 gates/precommit-install.mjs
//      冪等裝進 .git/hooks/pre-commit。兩條呼叫路徑共用同一組判定函式，杜絕規則漂移。
//   3) 「驗證垃圾」白名單原本 import 自 flow-toolkit/clean-verify-artifacts.mjs（該檔另兼 CLI 清理／
//      補 .gitignore 職責）。本檔只內聯 isCommitBlockableArtifact 判定所需的最小規則集（Tier A 絕對垃圾
//      檔名＋已知產物目錄清單），不認 Tier B（散落截圖／影片），避免誤擋使用者故意 commit 的資產。
//      當初未搬的「清理／補 .gitignore」職責已補齊為 gates/clean-artifacts.mjs，
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

// 本檔邏輯抽成 commitGateCheck(input) → { block, message }，供 pre-tool-use.mjs 動態 import 直接呼叫
// （PreToolUse 路徑，手動除錯改用 echo <json> | node pre-tool-use.mjs）；本檔只再保留 --precommit
// 這一個可執行入口，供 git 原生 pre-commit 呼叫（gates/precommit-install.mjs 裝進 .git/hooks/pre-commit）。
if (import.meta.url === pathToFileURL(process.argv[1] || '').href && process.argv.includes('--precommit')) {
  // 延到 nextTick 才跑：本入口位在模組頂部，下方的 const（ARTIFACT_DIRS/TICKET_PATH_RE…）尚在 TDZ，
  // 同步執行會 ReferenceError。
  process.nextTick(runPrecommit);
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

// ── 內聯：找出「真的是 git commit」的那一段（鏡像 git-guardrail.mjs 的切段/找子命令寫法）──
//
// 對抗審查 must-fix：切段依 tool_name 分兩套引號／跳脫規則（bash 用反斜線跳脫、PowerShell 用反引號
// 跳脫），並認得 bash 專有的 heredoc（<<TAG）——commit message 常常是多行 heredoc／here-string
// 寫法，本身就帶換行、分號、引號、管線符號；跳脫規則跟錯 shell 語意、或沒認出 heredoc 本文，都會讓
// 切段器誤判引號/段落邊界，把寫在訊息之後的 --no-verify 切到不算 commit 段的下一段，兜底判斷直接
// 漏看。引號／heredoc／here-string 掃到指令結尾都沒收尾（沒平衡）時回傳 null，呼叫端退回保守判定，
// 不硬信這次切段結果。
function splitChainSegments(cmd, tool) {
  const isPs = tool === 'PowerShell';
  const out = [];
  let cur = '';
  let i = 0;
  const n = cmd.length;
  let unterminated = false;
  while (i < n) {
    // heredoc（bash 專有語法，PowerShell 沒有）：<<[-]TAG／<<[-]'TAG'／<<[-]"TAG"，內文原樣吞掉
    // 直到收尾行為止，不套引號規則——訊息裡的英文縮寫撇號（don't）、分號、&& 都不該被當成引號/
    // 段落邊界。
    if (!isPs) {
      const hd = /^<<(-?)\s*(['"]?)(\w+)\2/.exec(cmd.slice(i));
      if (hd) {
        const dash = hd[1] === '-';
        const tag = hd[3];
        const bodyStart = i + hd[0].length;
        const closerRe = new RegExp('^' + (dash ? '[ \\t]*' : '') + tag + '[ \\t]*$', 'm');
        const m = closerRe.exec(cmd.slice(bodyStart));
        if (!m) unterminated = true;
        const end = m ? bodyStart + m.index + m[0].length : n;
        cur += cmd.slice(i, end);
        i = end;
        continue;
      }
    }
    // PowerShell here-string：@'…'@／@"…"@，只在 @ 後緊接換行時才成立（bash 沒有這種語法；沒接
    // 換行的 @"..."，例如 `curl -d @"f"`／`a@"b"`，不該被誤判成 here-string 一路吞到指令結尾）。
    if (isPs && cmd[i] === '@' && (cmd[i + 1] === "'" || cmd[i + 1] === '"') && /^\r?\n/.test(cmd.slice(i + 2))) {
      const closer = cmd[i + 1] + '@';
      const end = cmd.indexOf(closer, i + 2);
      if (end < 0) unterminated = true;
      const stop = end < 0 ? n : end + closer.length;
      cur += cmd.slice(i, stop);
      i = stop;
      continue;
    }
    const ch = cmd[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n && cmd[j] !== '"') {
        // PowerShell：反引號才是跳脫字元，雙引號內反斜線是字面字元（`"C:\repo\"` 這種以反斜線
        // 收尾的 Windows 路徑在這裡就該正常收尾）。bash：雙引號內反斜線跳脫（\" 不算收尾）。
        j += (isPs ? cmd[j] === '`' : cmd[j] === '\\') && j + 1 < n ? 2 : 1;
      }
      if (j >= n) unterminated = true;
      j = j < n ? j + 1 : j;
      cur += cmd.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "'") {
      // 單引號不支援跳脫（POSIX／PowerShell 一致），找下一個單引號就是收尾。
      let j = i + 1;
      while (j < n && cmd[j] !== "'") j += 1;
      if (j >= n) unterminated = true;
      j = j < n ? j + 1 : j;
      cur += cmd.slice(i, j);
      i = j;
      continue;
    }
    if (!isPs && ch === '\\' && i + 1 < n) {
      // bash：引號外的反斜線跳脫下一個字元，含 `'\''`（單引號字串裡插字面撇號）這種標準寫法、
      // `\;`、`\"` 等——不跳脫就會把跳脫字元後面的分隔符誤判成真正的段落分隔。
      cur += cmd.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (isPs && ch === '`' && i + 1 < n) {
      // PowerShell：引號外的反引號跳脫下一個字元（含跳脫引號 `"；跳脫換行＝續行，已在呼叫前處理）。
      cur += cmd.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (cmd.startsWith('&&', i) || cmd.startsWith('||', i)) { out.push(cur); cur = ''; i += 2; continue; }
    if (ch === ';' || ch === '|') { out.push(cur); cur = ''; i += 1; continue; }
    if (ch === '\n' || (ch === '\r' && cmd[i + 1] === '\n')) { out.push(cur); cur = ''; i += ch === '\r' ? 2 : 1; continue; }
    if (ch === '&' && cmd[i - 1] !== '&' && cmd[i + 1] !== '&' &&
        i > 0 && /\s/.test(cmd[i - 1]) && i + 1 < n && /\s/.test(cmd[i + 1])) {
      out.push(cur); cur = ''; i += 1; continue;
    }
    cur += ch;
    i += 1;
  }
  out.push(cur);
  return unterminated ? null : out; // null＝引號/heredoc/here-string 沒收尾，這次切段不可信
}

const COMMIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
const stripSegQuotes = t => t.replace(/^["']|["']$/g, '');

// ── 內聯：包殼展開＋子命令定位（鏡像 git-guardrail.mjs 的 tokenize/skipFlagValue/extractGitCalls
// 寫法，專找 commit 子命令，不做危險與否的判斷）──對抗審查 must-fix：短式 -n 包在殼裡（bash -c／
// cmd /c／powershell -Command／括號子殼／命令替換／-C 值是 $(...)）也要能精準定位到 commit 呼叫，
// 不能只靠長式 --no-verify 的整條字串保底（那道保底見下方 LOOKS_WRAPPED_RE）。
const CMD_C_WRAPPER_RE = /^\s*"?cmd(?:\.exe)?"?\s+\/c\s+(["'])([\s\S]*)\1\s*$/i;
const SH_C_WRAPPER_RE = /^\s*(?:\/[\w./-]*\/)?(?:bash|sh|powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:-c|-Command)\s+(["'])([\s\S]*)\1\s*$/i;
function expandWrappers(segment) {
  const m = segment.match(CMD_C_WRAPPER_RE) || segment.match(SH_C_WRAPPER_RE);
  if (!m) return [segment];
  const inner = splitChainSegments(m[2], 'Bash') || [m[2]];
  return inner.flatMap(expandWrappers);
}

// 簡化版 tokenize（鏡像 git-guardrail 的括號拆分＋反引號命令替換整段吞掉），只為了在段內定位
// commit 子命令，不需要 guardrail 等級的跳脫/引號完整還原。
function tokenizeSeg(segment) {
  const re = /"[^"]*"|'[^']*'|`[^`]*`|[()]|[^\s()]+/g;
  const out = [];
  let m;
  while ((m = re.exec(segment)) !== null) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

// 鏡像 git-guardrail.mjs 的 skipFlagValue：COMMIT_VALUE_FLAGS（-C/--git-dir…）的值可能橫跨多個
// token 且帶空白（`$(git rev-parse --show-toplevel)` 這類常見寫法），依括號深度一路吃到配對的
// 右括號為止，深度歸零後再吃緊貼著的殘留字。
function skipValueTok(toks, i) {
  let j = i + 1;
  if (j >= toks.length) return j;
  let end = toks[j].end;
  let depth = toks[j].text === '(' ? 1 : 0;
  j++;
  while (j < toks.length) {
    if (depth > 0) {
      if (toks[j].text === '(') depth++;
      else if (toks[j].text === ')') depth--;
      end = toks[j].end;
      j++;
      continue;
    }
    if (toks[j].start !== end) break;
    if (toks[j].text === '(') { depth++; end = toks[j].end; j++; continue; }
    end = toks[j].end;
    j++;
  }
  return j;
}

// 找出這段裡「所有 git commit 呼叫」子命令後的參數字串（供 -n/--no-verify 判斷用）。對抗審查
// must-fix：逐一檢查段內所有 git token（不只第一個），任何一個的子命令是 commit 就收進結果——
// 避免併段或多重 git 呼叫時，第一個 git 的子命令不是 commit 就整段判定失敗。rest 保留原始引號
// 字元（不在這裡剝殼），讓 stripMessageValues 能正確挖掉 -m/-F 的值，訊息內文才不會誤判成旗標。
function findCommitCallsInSegment(segment) {
  const toks = tokenizeSeg(segment);
  const rests = [];
  for (let gi = 0; gi < toks.length; gi++) {
    const t0 = stripSegQuotes(toks[gi].text);
    if (!/^git(\.exe)?$/i.test(t0) && !/[\\/]git(\.exe)?$/i.test(t0)) continue;
    let depth = 0;
    let sub = null;
    const restToks = [];
    for (let i = gi + 1; i < toks.length; i++) {
      const raw = toks[i];
      if (raw.text === '(') { depth++; if (sub !== null) restToks.push(raw.text); continue; }
      if (raw.text === ')') { if (depth <= 0) break; depth--; if (sub !== null) restToks.push(raw.text); continue; }
      if (sub === null) {
        const t = stripSegQuotes(raw.text);
        if (t.startsWith('-')) { if (COMMIT_VALUE_FLAGS.has(t)) i = skipValueTok(toks, i) - 1; continue; }
        sub = t;
        continue;
      }
      restToks.push(raw.text);
    }
    if (sub === 'commit') rests.push(restToks.join(' '));
  }
  return rests;
}

// 挖掉 -m/-F 的值（含 here-string 與雙引號轉義），但保留旗標字母本身——`-anm "msg"` 這種以 m 結尾的
// 組合旗標，值被挖掉後仍看得到裡面的 n（--no-verify 短式），不會因為挖值連旗標一起消失而漏擋。
// -[a-zA-Z]*m\s*（而非 \s+）同時吃緊湊寫法 `-m"msg"`/`-mmsg`（無空白），否則訊息不被挖除＝假阻擋。
function stripMessageValues(text) {
  return text
    .replace(/(-[a-zA-Z]*m)\s*@(['"])[\s\S]*?\2@/g, '$1 ')     // PowerShell here-string message
    .replace(/(-[a-zA-Z]*m)\s*"(?:\\.|[^"\\])*"/g, '$1 ')      // 雙引號 message（吞轉義 \" 不提前收尾）
    .replace(/(-[a-zA-Z]*m)\s*'[^']*'/g, '$1 ')                // 單引號 message（POSIX 無轉義）
    .replace(/(-F)\s+\S+/g, '$1 ')                             // -F <file>
    .replace(/['"]/g, ' ');                                    // 去殘餘引號字元（"--no-verify" → --no-verify）
}

// 對抗審查 must-fix：整條指令「看起來像包了殼層／子殼／命令替換」時才啟用整條字串掃長式
// --no-verify 的保底——否則 `git log -S "--no-verify" -- gates/commit-gate.mjs`、
// `grep -n -- --no-verify DESIGN.md` 這類同一行剛好同時出現 git…commit（如檔名 commit-gate.mjs）
// 與 --no-verify 字面值（如 grep 的查詢樣式）的唯讀指令，會被誤判成想繞過 pre-commit。
const LOOKS_WRAPPED_RE = /[()]|\bbash\b|\bsh\b|\bcmd(?:\.exe)?\b|\bpowershell(?:\.exe)?\b|\bpwsh(?:\.exe)?\b/i;

// 純判定（不碰 exit/stderr）。呼叫端負責 fail-open（try-catch）與輸出。
export function commitGateCheck(input) {
  const tool = input.tool_name ?? input.toolName ?? '';
  if (tool !== 'Bash' && tool !== 'PowerShell') return PASS;
  const ti = input.tool_input ?? input.toolInput ?? {};
  const rawCmd = String(ti.command ?? '');
  // 對抗審查 must-fix：續行先拿掉再切段——bash `\`+換行、PowerShell 反引號+換行都是續行語法，
  // 續行後半段常常就是 --no-verify/-n，樸素換行切段會把它切到不算 commit 段的下一段而漏擋。
  const cmd = tool === 'PowerShell' ? rawCmd.replace(/`\r?\n/g, ' ') : rawCmd.replace(/\\\r?\n/g, ' ');

  // 便宜的前置關卡：整條指令連 git…commit 字樣都沒有，不可能是 commit，直接放行、不必再解析。
  const GIT_COMMIT_LOOSE_RE = /\bgit\b[^\n]*\bcommit\b/i;
  if (!GIT_COMMIT_LOOSE_RE.test(cmd)) return PASS;

  const cwd = input.cwd ?? process.cwd();
  const root = resolveRepoRoot(cwd); // R9：一律用 git rev-parse --show-toplevel 解析、失敗 fallback cwd
  if (!existsSync(join(root, '.constellation'))) return PASS; // 非 Constellation 專案

  // 只攔真正的 commit：整條指令切段、展開包殼，逐一找出真正的 commit 呼叫——不對整條指令字串做
  // 關鍵字掃描，避免 `sed -n`、`tail -n`、`grep -rn` 這類同一行裡剛好出現 git/commit 字眼的非 commit
  // 指令被誤攔（--amend 不豁免，見檔頭；commit-graph/commit-tree 這類非提交子命令天然不等於
  // 'commit'，不會誤攔）。segments 為 null 代表引號/heredoc/here-string 沒收尾，這次切段不可信，
  // 底下就當「一個 commit 呼叫都定位不到」處理，退回保守判定。
  const segments = splitChainSegments(cmd, tool);
  const commitRests = [];
  if (segments) {
    for (const seg of segments) {
      for (const expanded of expandWrappers(seg)) commitRests.push(...findCommitCallsInSegment(expanded));
    }
  }

  // ── 補堵「繞過 pre-commit 兜底」的旗標 ──
  // --no-verify/-n 優先看精準定位到的 commit 呼叫（旗標只對該子命令有意義，別段的 -n 如
  // `git log -n 1`、`tail -n 20` 不該連坐）；一個 commit 呼叫都定位不到時，才視情況退回整條指令
  // 的保底（見 LOOKS_WRAPPED_RE，對抗審查 must-fix：避免把唯讀指令誤判成繞過）。core.hooksPath
  // 改向是獨立的 git 段，本來就要看整條指令，不受這裡的精準/保底分流影響。
  const preciseNoVerify = commitRests.some((rest) => {
    const flags = stripMessageValues(rest);
    return /(^|\s)--no-verify(\s|$)/.test(flags) || /(^|\s)-[a-z]*n[a-z]*(\s|$)/.test(flags);
  });
  const fallbackNoVerify = commitRests.length === 0 && LOOKS_WRAPPED_RE.test(cmd) &&
    /(^|\s)--no-verify(\s|$)/.test(stripMessageValues(cmd));
  const wholeFlags = stripMessageValues(cmd);
  const hooksPathBypass = /-c\s+core\.hooksPath\b/i.test(wholeFlags) || /\bconfig\b[^\n]*\bcore\.hooksPath\b/i.test(wholeFlags);
  if (preciseNoVerify || fallbackNoVerify || hooksPathBypass) {
    return BLOCK([
      'Constellation commit 守門：擋下 commit —— 命令帶了 --no-verify/-n 或改向 core.hooksPath（會繞過 pre-commit 兜底）。',
      '  secrets／驗證垃圾防護要靠 pre-commit 兜住整批繞法，別在自動流程裡關掉它（-n 是 --no-verify 短式、git config core.hooksPath 持久改向同理）。',
      '  真有正當理由跳過（例如 hook 本身壞了）→ 回報使用者由人拍板，別自行繞過。',
    ].join('\n'));
  }

  // ── 三道閘門 ──
  // 對抗審查 must-fix：只要整條指令看得出 git…commit 字樣、且在 Constellation 專案內，就一律跑三道
  // 檔案閘門——不再依賴「精準定位到 commit 呼叫」，包殼／子殼認不出來時三道閘門也不能跟著 fail-open
  // （成本只多一次 git diff --cached；staged 內容乾淨就不會誤擋）。
  const staged = stagedFiles(root); // 取一次，三道共用；取不到＝null＝三道 fail-open
  const secret = secretsReason(root, staged);
  if (secret) return BLOCK(secret);
  const artifact = artifactsReason(staged);
  if (artifact) return BLOCK(artifact);
  const doneAudit = doneTicketAuditReason(root, staged);
  if (doneAudit) return BLOCK(doneAudit);

  return PASS;
}
