#!/usr/bin/env node
// gates/commit-gate.mjs — Constellation commit 守門（PreToolUse on Bash|PowerShell）。
// 從 Flow flow-commit-gate.mjs（+ commit-gate-core.mjs）搬入並去 Flow 化，攔 `git commit`，保留兩道
// 核心確定性防護：
//   閘門〇「secrets 不進歷史」：staged 含 .env/私鑰類檔案 → 擋下，先移出 staging＋補 .gitignore。
//   閘門一「先清、再 commit」：staged 含驗證垃圾（測試/驗證過程產物，含 .playwright-mcp 的 MCP 殘留）→ 擋下。
// 另補「模型端繞過 pre-commit」防線：命令帶 --no-verify/-n 或改向 -c core.hooksPath → 擋下（human 在終端機
// 自己打的不過本 hook，--no-verify 對人仍是 documented 逃生門、reflog 可稽核）。
// `--amend` 不豁免：兩道閘門照常判斷當下 staged 內容。
// 設計鐵則：fail-open（解析不出 / 非 git commit / 非 Constellation 專案 / git 或例外 → 一律放行，絕不誤擋）。
//
// ── 去 Flow 化紀錄（供整合者核對，勿在後續同步流程中復原以下行為）──
//   1) 原檔第三道閘門「先標、再 commit」（比對 commit message 點名的 flow task 是否已在 .flow ledger 標
//      delivered，依賴 flow-toolkit/statelib.mjs 與 flow-state.mjs）已整支剝除，不搬。Constellation 的
//      等效防護落在獨立的「關票刷卡機」（gates/close-gate.mjs，票標 done 時檢查驗證證據存在且新鮮），
//      責任點在「關票」而非「commit 當下」，兩者本就該分開、也避免本檔對 flow-toolkit 產生跨專案依賴。
//   2) 原本 secrets／驗證垃圾判定抽在共用檔 commit-gate-core.mjs（供 git 原生 pre-commit 對應檔
//      flow-precommit.mjs 共用），Constellation 這次未搬原生 pre-commit 對應檔，故本檔內聯全部判定
//      邏輯，改為單檔自足，不再依賴外部 core 檔。
//   3) 「驗證垃圾」白名單原本 import 自 flow-toolkit/clean-verify-artifacts.mjs（該檔另兼 CLI 清理／
//      補 .gitignore 職責，不在本次搬遷範圍）。本檔只內聯 isCommitBlockableArtifact 判定所需的最小規則集
//      （Tier A 絕對垃圾檔名＋已知產物目錄清單），不含清理或 .gitignore 功能；擋下時的建議動作也相應改為
//      `git restore --staged` 手動移出，不再呼叫外部清理腳本。
//   4) 生效範圍門檻由「.flow 存在」改為「.constellation 存在」——僅在已採用 Constellation 工作流的專案
//      生效，非本工作流專案不受影響（與原檔「非 flow 專案放行」同一設計精神，只是換了目錄名）。
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const exit0 = () => process.exit(0);
const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

const PASS = { block: false };
const BLOCK = msg => ({ block: true, message: msg });

// 本檔邏輯抽成 commitGateCheck(input) → { block, message }，供未來若把多支 PreToolUse 閘門合併成單一
// dispatcher 時直接 import 呼叫；也保留獨立 main() 讓本檔仍可單獨當 hook 跑（測試/相容）。
// **只有直接執行本檔時才掛 stdin/main**——被其他程式 import 時不可自動跑，否則會搶先 exit 短路呼叫端。
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
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

// ── 內聯：驗證垃圾白名單判定（原 flow-toolkit/clean-verify-artifacts.mjs 的最小子集，見去 Flow 化紀錄③）──
// 只認 Tier A（絕對垃圾）＋已知產物目錄；不含原檔的 Tier B（散落截圖/影片，需另查 git untracked 才清），
// 避免在 commit-gate 這種輕量判定裡誤擋使用者故意 commit 的資產。
const ARTIFACT_DIRS = new Set([
  'test-results', 'playwright-report', '.playwright',     // @playwright/test
  '.playwright-mcp', 'playwright-mcp-output',             // @playwright/mcp 操作殘留
  'coverage', '.nyc_output', 'htmlcov',                   // 覆蓋率
  '.pytest_cache', '__pycache__',                         // pytest / Python
]);
const HARD_FILE_RE = [
  /\.log$/i,
  /^\.last-run\.json$/i,
  /\.trace\.zip$/i,
  /\.pyc$/i,
  /^debug[-.].*\.(png|jpe?g|gif|json|txt|html)$/i,
  /^(tmp|temp|scratch)[-.].*/i,
  /\.tmp$/i,
];
// 絕不誤判：source 測試檔＋刻意留存的 reference data（交付物）優先於上面所有規則。
const KEEP_RE = [
  /\.(test|spec)\.[cm]?[jt]sx?$/i, /_test\.[a-z]+$/i, /(^|[/\\])conftest\.py$/i,
  /baseline/i, /golden/i, /snapshot/i, /\.fixture\./i,
];
// 歧義命名前綴（tmp-/temp-/scratch-/debug-）＋已知原始碼副檔名＝多半是正常檔非垃圾，排除掉，
// 避免誤擋 src/temp-storage.ts、debug-config.json 這類正常原始碼。
const AMBIGUOUS_PREFIX_RE = /^(tmp|temp|scratch|debug)[-.]/i;
const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|h|hpp|cpp|cc|cs|swift|kt|scala|css|scss|less|vue|svelte|json|jsonc|toml|md|mdx|html?|sql|sh|graphql|gql|proto)$/i;

const keepPath = base => KEEP_RE.some(re => re.test(base));
const underArtifactDir = relpath => relpath.split(/[/\\]/).some(seg => ARTIFACT_DIRS.has(seg));
const isHardArtifact = base => {
  if (keepPath(base) || !HARD_FILE_RE.some(re => re.test(base))) return false;
  if (AMBIGUOUS_PREFIX_RE.test(base) && SOURCE_EXT_RE.test(base)) return false;
  return true;
};
function isCommitBlockableArtifact(relpath) {
  const base = relpath.split(/[/\\]/).pop() || relpath;
  if (keepPath(base)) return false;
  return underArtifactDir(relpath) || isHardArtifact(base);
}

// ── 內聯：staged 清單 + 閘門〇（secrets）+ 閘門一（驗證垃圾）判定（原 commit-gate-core.mjs，見去 Flow 化紀錄②）──
function stagedFiles(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'diff', '--cached', '--name-only', '-z'], { maxBuffer: 1 << 26 })
      .toString('utf8').split('\0').filter(Boolean);
  } catch { return null; } // 取不到＝fail-open，兩道檔案閘門都放行
}

// 檔名白名單式偵測（確定性、近零額外 IO）；樣板（*.example 等）與公鑰放行。
// .npmrc/.pypirc 常見且多半只有 registry 設定 → 只在 staged 內容真含 token/password 才擋（讀 staged 版本）。
function secretsReason(cwd, staged) {
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
      const body = execFileSync('git', ['-C', cwd, 'show', ':' + p], { maxBuffer: 1 << 20 }).toString('utf8');
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
    '  先移出 staging 再 commit（多半是測試/驗證跑出的暫存產物，非交付內容）：',
    ...trash.slice(0, 10).map((p) => `    git restore --staged "${p}"`),
    '  建議順手補進 .gitignore，避免下次又被 git add -A 吃進來。別手改繞過本閘門。',
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
  if (!existsSync(join(cwd, '.constellation'))) return PASS; // 非 Constellation 專案

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

  // ── 兩道閘門 ──
  const staged = stagedFiles(cwd); // 取一次，兩道共用；取不到＝null＝兩道 fail-open
  const secret = secretsReason(cwd, staged);
  if (secret) return BLOCK(secret);
  const artifact = artifactsReason(staged);
  if (artifact) return BLOCK(artifact);

  return PASS;
}
