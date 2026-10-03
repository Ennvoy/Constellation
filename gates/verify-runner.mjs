#!/usr/bin/env node
// Constellation 閘門 4 —— 驗證 runner（CLI，非 hook）。DESIGN.md §4／§5。
// 用法：
//   逐票：node verify-runner.mjs --ticket <票路徑或純票號> [--cwd <專案根>] [--scope ticket]
//   出貨：node verify-runner.mjs --scope ship [--cwd <專案根>]
// --scope ticket（預設）：要求 --ticket。票內有「## 驗證指令」section（weave 拆票時寫定的縮圈清單，
//   見 ticket-template.md）就跑該清單；沒有就跑 config 的 commands.test 全量——fallback 永遠是全量，
//   縮圈只因「票裡明寫了」而發生。證據寫回該票檔。
// --scope ship：不要求 --ticket，跑 commands.test＋commands.journey 全量（票內縮圈清單一律不看），
//   證據寫入 {cwd}/.constellation/ship-evidence.md（沒有這個檔就自動建立）。開跑前先搶「同專案」的
//   出貨鎖（gates/lease.mjs，決議 026、033：每個專案一把，鍵是主工作樹根，同 repo 的各 worktree 同一把）：
//   搶到才開始跑；被同專案的別人佔著就每 5 秒重試、先印一次持有者、之後每 10 分鐘印一行，
//   `--max-wait <秒，預設 14400＝4 小時>` 逾時用代碼 3 結束（不計入斷路器、不寫失敗紀錄）；
//   子孫行程重入（環境變數 CONSTELLATION_LEASE_ACQUIRED）視為已持有，不再搶不再等。別的專案持有出貨鎖
//   不排隊，只在開跑時與紅燈收尾時印一行提醒（noteShipLeaseIfHeld，讀所有專案的登記）。
//   --scope ticket 不搶鎖，持有方存在時只印一行提醒，逐票驗證照跑不受影響。
// --ticket 可以給純票號（如 T-003）：先試直接路徑，找不到就在 .constellation/tickets/ 下
// glob `<票號>*.md`，唯一命中才用；零命中或多重命中一律報錯並列出候選，不猜。
// 全部指令 exit 0 才落一筆「## 驗證證據」（時間戳＋各指令＋exit code＋stdout 尾 8 個非空白行＋簽章）；
// 任一失敗：主控台只印該指令輸出最後 40 行、完整輸出另存到系統暫存目錄並印出路徑、不落這筆簽章證據、
// exit 1（或斷路器觸發時 exit 2；runner 自身的退出碼判斷不變，只是印法改了）——證據不能靠人手填，
// 必須是這支 runner 親自跑出來的。--scope ship 的失敗路徑另外會在 ship-evidence.md 檔尾 append 一段
// 未簽章的「## 失敗紀錄」（指令＋exit code＋耗時＋輸出摘要，僅供追查，不參與關票／出貨判定）；
// --scope ticket 的失敗路徑不寫任何東西進票檔。
// 證據筆另附一行各指令耗時（「- 耗時：合計 Ns｜…」，獨立行、不帶反引號、不含「（exit」）——close-gate／
// commit-gate 的證據行解析（COMMAND_LINE_RE 行尾錨定「（exit N）」）天然忽略本行；儀表用途，不參與簽章。
//
// R1 證據防偽：光「不能手填時間戳」不夠——時間戳本身也是純文字，手改票檔一樣能塞一個 24 小時內的
// ISO 字串。真正的防偽來自簽章：對「ISO 時間戳＋票檔相對路徑（或 "ship"）＋全部指令串接＋輸出尾行
// ＋repo 根絕對路徑」算 HMAC-SHA256（secret 只存在使用者家目錄、不進 git、不落 repo），證據筆尾附一行
// `sig: <hex>`。沒有這把 secret 就無法算出合法簽章，手填時間戳因此真的擋不過關票刷卡機（gates/close-gate.mjs）。
// repo 根這段是防「跨專案重放」——把另一個專案跑出來的合法證據筆整段複製貼到這個專案的票裡，簽章對不上。
// 簽章與解析的唯一實作在 gates/evidence.cjs（P14：三份鏡像合一），本檔靜態 import（見下方 import
// 區塊）：SECRET_PATH／readSecret／ticketRelPath／repoRootToken／computeSignature／COMMAND_LINE_RE
// 都從那支模組來——runner 是簽證據的來源，模組壞了就讓 runner 直接跑不出來（fail-closed）。這是
// P14 新增的代價：重構前讀不到 secret 時 runner 照跑、寫 sig: unsigned；現在模組整支壞掉，runner
// 所有模式（含 --scope ship 全量與機器鎖排隊）都會直接跑不出來——換來的是大聲擋下而非悄悄退化，
// 代價可接受，但不是「本來就是」。close-gate.mjs／commit-gate.mjs 則是延遲用 createRequire 同步
// 載入同一支模組（見兩檔檔頭說明），三邊呼叫的是同一份實作，不再是各自內聯一份鏡像。
//
// 斷路器（R2）：{cwd}/.constellation/.verify-state.json 記 per-target（票相對路徑或 "ship"）連續失敗
// 計數；成功歸零、失敗 +1；達 5 次時 exit 2，請使用者拍板，不再盲目重試（見 recordFailure）。
// ship 目標另有一條歸零路徑（P15）：--scope ship 開跑前若 ship-evidence.md 不存在（代表新一輪，
// 例如剛歸檔完），一律先歸零——手動刪掉這個檔等同刪計數檔硬闖，不是合法繞過（phase-build.md 已
// 明文禁止）。
//
// 逾時判定（P9）：timeoutSec 是「連續多久沒有任何輸出」的上限，不是從開跑算起的總時長——每收到一段
// stdout／stderr 就重設這顆計時器（只在還沒結束、還沒判定逾時時重設；結束後的 2 秒寬限期、以及已判定
// 逾時後才到的資料，都不重設），健康但越跑越久的套件不會被腰斬。另加一條不必設定的 6 小時總上限
// （ABSOLUTE_MAX_MS，不受重設影響，從指令開跑起算），防「一直印卻永遠不結束」的失控指令。
//
// 殘留 server 清理（S1／S2）：驗證指令起的 server 若沒被收掉，會佔著埠拖垮後續驗證，甚至讓下一輪
// e2e 沿用舊 build 的 server 跑出假合格（正確性問題，不只效能）。兩層機制，僅 Windows 生效
// （靠 netstat／taskkill）——非 Windows 平台不只 S2 補刀不生效，S1 逾時殺樹也只殺得到外殼本身
// （spawn 沒帶 detached，process.kill(-pid) 多半 ESRCH），子孫照跑：
//   S1 血緣殺——指令改用 spawn（shell:true）起、runner 自管逾時，逾時就 taskkill /PID <外殼> /T /F
//      殺整棵活樹；spawnSync 的 timeout 只殺 cmd.exe 外殼，npx→node→server 這種孫進程鏈會繼續跑。
//      指令結束判定改用 'exit'（進程已退出）而非 'close'（stdio 全關）——孫進程繼承 stdio handle 時
//      close 事件永遠不來，會白等到逾時；exit 後最多再等 2 秒讓管線把剩餘輸出吐完就結算。
//      taskkill 本身也可能殺不動（子進程提權、taskkill 不在 PATH、防毒攔截），所以殺完再排一道
//      保險期限，到期就自己 kill 外殼並無論如何結算——逾時一定會回來，runner 不會無限等。
//   S2 埠差集補刀——每條指令前後各照一次「LISTENING 位址:埠 → pid」快照（前一條的 after 直接當
//      下一條的 before，N 條指令 N+1 次快照），新增的埠當候選，一次查全機進程表（pid → 父／建立
//      時間／命令列），**四道豁免全過才殺**：①config.json 的 protectedPorts（陣列）白名單埠；
//      ②serve.mjs 登記在 .constellation/.servers.json 的 pid／外殼 pid（那些由 serve.mjs 的 stop／
//      SessionEnd 負責收，兩層機制不互打——驗證指令裡用 serve.mjs start 起的 server 若被補刀殺掉，
//      後續指令會拿到假紅燈）；③建立時間必須晚於本條指令開始；④血緣：沿 ParentProcessId 鏈往上
//      走得回本條指令的外殼 pid（見 isOwnDescendant）。第④道是誤殺的主防線，也是整套補刀裡唯一
//      「這是我起的」正面證明——埠差集與時間窗口都只是旁證，別的專案／session 起的 server 落在
//      窗口內就會中招。
//      代價是漏殺「鏈上中間層自己也退出了」的多層孤兒（往上走到不在表裡的 pid 就停手）——補刀
//      本來就只是補刀，寧漏勿誤殺。
// 每條指令跑完（含逾時、含失敗）都 reap 一次，所有出口因此都在退出前清乾淨。清理訊息一律印在
// runner 自己的 stderr，不混進指令輸出，故不進證據 tail、不影響簽章。
// ⚠ 已知限制：快照靠 netstat 輸出的 "LISTENING" 字串，在狀態字被本地化的 Windows 語系上會抓到空
//    集合，整套補刀無聲失效（fail-safe 方向：不誤殺，只是不生效）。
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve, join, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import {
  projectKey, readHolder, listHolders, peekHolder, isPidAlive, myStartedAtMs, acquire as acquireLease, invalidate as invalidateLease,
  invalidateCorrupt as invalidateCorruptLease, release as releaseLease,
  updateShellPid as updateLeaseShellPid, estimateEndFromShipEvidence, formatHolder,
} from './lease.mjs';
// 簽章與解析的唯一實作在 gates/evidence.cjs（P14：三份鏡像合一）。runner 是 CLI（不是 hook），
// 靜態 import——模組壞了就讓 runner 直接跑不出來（fail-closed）。這是 P14 新增的代價，不是既有
// 精神：重構前讀不到 secret 時 runner 照跑、寫 sig: unsigned，現在模組整支壞掉會讓 runner 所有
// 模式都跑不出來，含 --scope ship 全量與機器鎖排隊——runner 已經靜態 import 同層的 lease.mjs，
// 這個代價可以接受，但要照實記為代價（runner 本身仍是簽證據的來源，模組壞掉時讓它直接失敗，
// 好過帶著壞掉的簽章邏輯繼續跑）。
// ⚠ 這是具名匯入 CJS，Node 靠 evidence.cjs 的 `module.exports = { a, b, ... }` 這種簡寫（值就是同名
// 變數）才能靜態推出匯出名稱——evidence.cjs 的 module.exports 若插入「值不是同名變數」的項目（例如
// `X: 5*60*1000`），它後面的名稱會推不出來，runner 啟動時直接 SyntaxError（大聲失敗，不會靜默放行，
// 但仍值得避免）。改動 evidence.cjs 的 module.exports 時維持簡寫，或都放最後面。
import { SECRET_PATH, readSecret, ticketRelPath, repoRootToken, computeSignature, COMMAND_LINE_RE, signingRoot } from './evidence.cjs';

const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// 沒給 --cwd 時，從目前目錄往上找專案根：認 `.constellation` 目錄本身存在（不要求 config.json——
// 見 close-gate.mjs 同名函式的 P3 殘留說明：config.json 要到 weave 階段才生成，只認它會在 design
// 階段把根找錯）。家目錄判斷順序很關鍵：**先**判斷是否已經走到家目錄、**再**檢查 `.constellation`
// 存不存在——家目錄底下的 ~/.constellation/ 只放簽章 secret（目錄本身確實存在），順序反過來會把
// 家目錄誤判成專案根。找不到就回原目錄，讓後面讀 config.json 失敗時給出原本就有的錯誤訊息。與
// close-gate.mjs 找專案根同一套邏輯，各自內聯一份，不共用 import——這是決議 023 否決「熱路徑小函式
// 抽共用檔」那條的範圍，不屬於 P14 合一的 evidence.cjs（那支模組只管簽章驗證）。
function findProjectRoot(from) {
  const home = resolve(homedir()).toLowerCase();
  let dir = resolve(from);
  for (;;) {
    if (dir.toLowerCase() === home) return resolve(from);
    if (existsSync(join(dir, '.constellation'))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(from);
    dir = up;
  }
}

function parseArgs(argv) {
  const out = { ticket: '', cwd: '', scope: 'ticket', maxWait: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ticket') out.ticket = argv[++i] || '';
    else if (argv[i] === '--cwd') out.cwd = argv[++i] || '';
    else if (argv[i] === '--scope') out.scope = argv[++i] || '';
    else if (argv[i] === '--max-wait') out.maxWait = argv[++i] || '';
  }
  return out;
}

// --ticket 支援純票號（如 "T-003"）：先試把它當相對路徑直接解析，找得到檔案就用；找不到就當票號，
// 在 .constellation/tickets/ 下找 `<票號>*.md`，唯一命中才用——零命中或多重命中一律報錯列候選，不猜。
function resolveTicketPath(cwd, ticketArg) {
  const direct = resolve(cwd, ticketArg);
  if (existsSync(direct)) return direct;

  const ticketsDir = join(cwd, '.constellation', 'tickets');
  let files = [];
  try { files = readdirSync(ticketsDir).filter(f => f.toLowerCase().endsWith('.md')); } catch { files = []; }

  const prefix = basename(String(ticketArg).trim());
  const candidates = files.filter(f => f.startsWith(prefix));
  if (candidates.length === 1) return join(ticketsDir, candidates[0]);
  if (candidates.length === 0) {
    console.error(`找不到票檔：直接路徑 "${direct}" 不存在，當票號解析也在 ${ticketsDir} 下找不到符合 "${prefix}*.md" 的檔案。`);
    process.exit(1);
  }
  console.error(`票號 "${prefix}" 對應多張票，無法判斷唯一，請改用完整路徑指定：`);
  for (const c of candidates) console.error(`  - ${join('tickets', c)}`);
  process.exit(1);
}

// 票級縮圈：票內可選的「## 驗證指令」section（weave 拆票時寫定，規則見 ticket-template.md）。
// 列項格式與證據筆的指令行同款（- `cmd`）；section 存在且至少一條指令就取代 config 的
// commands.test，否則回空陣列、由呼叫端 fallback 到全量——寧全量勿漏，縮圈永遠是顯式的。
// 只在 --scope ticket 生效；ship 全量驗證不看這個 section。
// ⚠ 三道防呆：本函式最危險的失效方式**不是報錯，是靜默少跑卻照樣蓋章**——產出一份看似完整、
// 實則沒驗到的簽章證據。紅燈操作者看得見，假合格證看不見。三種踩法都實際發生過：
//   ① 指令行後面加了說明文字（`- ``cmd``（需先起 server）`）→ 該行不符 SCOPED_CMD_RE 被靜默跳過，
//      runner 回報「跑 3 條、全數通過」卻不提第 4 條漏了。**唯一會產生假證據的一種，故 fail-stop。**
//   ② 標題寫成「## 驗證指令的兩點說明」→ 舊的 `.*$` 正則把說明段當成 section，讀出 0 條。
//   ③ 檔內出現兩個「## 驗證指令」標題（其一為空）→ runner 只讀第一個，另一個無聲失效。
// ②③ 的後果是 fallback 到 config 全量（比縮圈更嚴、不會漏驗），但操作者會誤以為縮圈生效，故一律出聲。
const SCOPED_HEADING_RE = /^##[ \t]*驗證指令[ \t]*$/m; // 只認純標題，不吃後綴
const SCOPED_HEADING_LOOSE_RE = /^##[ \t]*驗證指令.*$/m; // 偵測「像標題但寫壞了」
const SCOPED_CMD_RE = /^\s*-\s*`(.+)`\s*$/;
const SCOPED_ITEM_RE = /^\s*-\s+\S/; // section 內的任何列項

function parseScopedCommands(content, ticketPath = '(票檔)') {
  const heads = content.match(new RegExp(SCOPED_HEADING_RE.source, 'gm')) || [];
  if (heads.length > 1) {
    console.error(
      `Constellation 驗證 runner：擋下——${ticketPath} 有 ${heads.length} 個「## 驗證指令」標題。\n` +
        `runner 只會讀第一個，其餘無聲失效。請合併成一個；說明文字改用 ### 小標，` +
        `且小標不要以「驗證指令」開頭。`,
    );
    process.exit(1);
  }

  const m = content.match(SCOPED_HEADING_RE);
  if (!m) {
    const loose = content.match(SCOPED_HEADING_LOOSE_RE);
    if (loose) {
      console.warn(
        `⚠ ${ticketPath} 的「${loose[0].trim()}」帶了後綴文字，不算縮圈清單——這一輪改跑 config 的全量 commands.test。\n` +
          `  縮圈清單的標題必須剛好是「## 驗證指令」；說明請寫在清單外的 ### 小標底下。`,
      );
    }
    return [];
  }

  const after = m.index + m[0].length;
  const rest = content.slice(after);
  const next = rest.match(/\n##\s/);
  const section = next ? rest.slice(0, next.index) : rest;
  const cmds = [];
  const bad = [];
  for (const line of section.split(/\r?\n/)) {
    const cm = line.match(SCOPED_CMD_RE);
    if (cm) {
      cmds.push(cm[1]);
      continue;
    }
    if (SCOPED_ITEM_RE.test(line)) bad.push(line.trim());
  }

  if (bad.length) {
    console.error(
      `Constellation 驗證 runner：擋下——${ticketPath} 的「## 驗證指令」清單裡有 ${bad.length} 個列項不是合法指令行。\n` +
        `這些行會被無聲跳過而少驗，但 runner 仍會回報「全數通過」——產出看似完整、實則沒驗到的簽章證據：\n` +
        bad.map((b) => `    ${b}`).join('\n') +
        `\n\n格式規則：整行只能是「- \`指令\`」，收尾反引號後面不得有任何文字（含中文括號說明）。\n` +
        `說明一律寫在清單外的 ### 小標底下。`,
    );
    process.exit(1);
  }

  if (!cmds.length) {
    console.error(
      `Constellation 驗證 runner：擋下——${ticketPath} 有「## 驗證指令」標題，但一條指令都讀不出來。\n` +
        `本票若不需要縮圈，請把整個 section 刪掉（runner 會自動跑 config 的全量 commands.test）；\n` +
        `需要縮圈就補上「- \`指令\`」格式的列項。`,
    );
    process.exit(1);
  }

  return cmds;
}

// commands.test / commands.journey 可以是單一字串或字串陣列，統一收成陣列。
function toCommandList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === 'string') return v.trim() ? [v] : [];
  return [];
}

// 主控台失敗預覽：字面最後 N 行（含空白行），只給人看，不進證據、不參與簽章。
function tail(text, maxLines = 15) {
  const lines = String(text ?? '').split(/\r?\n/);
  return lines.slice(-maxLines).join('\n');
}

// 輸出尾行：一段文字裡最後一個非空白行；找不到則回空字串。
function lastNonBlankLine(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') return lines[i];
  }
  return '';
}

// 證據段落尾巴：取最後 N 個「非空白」行（trim 後非空字串才算，行本身原樣保留），而非字面最後 N 行——
// reporter 常在收尾多印幾行空白，字面切法會把真正有內容的行擠出視窗外。找不到非空白行則回空字串。
function lastNonBlankLines(text, n) {
  const lines = String(text ?? '').split(/\r?\n/);
  return lines.filter(l => l.trim() !== '').slice(-n).join('\n');
}

// 證據跳脫：輸出裡長得像「fence 收尾」或「已簽章指令行」的行，前面加零寬字元（U+200B）再寫入與簽章。
// 這兩個正則對應 close-gate.mjs／commit-gate.mjs 解析證據區塊時用的邊界判準（找第一個 4 空白＋``` 收尾
// fence；COMMAND_LINE_RE 行尾錨定「（exit N）」）——輸出裡若剛好有一行長這樣，會把證據區塊提早收尾或
// 被誤當成另一條指令行，合法證據永遠驗簽失敗、還誤導成「可能被竄改」。U+200B 不屬於 JS 正則的 \s，
// 兩邊正則因此不再誤配，卻不影響肉眼閱讀；close-gate／commit-gate 完全不動，只要這裡跳脫、簽章也對
// 跳脫後的文字算，兩邊各自獨立驗證就一致。
const EVIDENCE_FENCE_LINE_RE = /^```\s*$/;
function escapeEvidenceText(text) {
  return String(text ?? '')
    .split('\n')
    .map(l => (EVIDENCE_FENCE_LINE_RE.test(l) || COMMAND_LINE_RE.test(l) ? `​${l}` : l))
    .join('\n');
}

// 驗證失敗時的完整輸出存檔路徑：<系統暫存目錄>/constellation-verify/<repo 根雜湊>-<target 安全檔名>.log。
// 每次覆寫（同一 repo＋target 下一次失敗會蓋掉這次），不累積；檔名雜湊 repo 根避免不同專案撞名，
// target 轉安全字元避免票檔路徑裡的斜線被誤解成子目錄。
function failureLogPath(cwd, target) {
  const repoHash = createHash('sha256').update(repoRootToken(cwd)).digest('hex').slice(0, 12);
  const safeTarget = String(target).replace(/[\\/:*?"<>|]+/g, '_');
  return join(tmpdir(), 'constellation-verify', `${repoHash}-${safeTarget}.log`);
}

// 失敗段落檔前的遮密（verification-playbook.md「證據遮密」：金鑰／token／密碼一律 <REDACTED>）：
// --scope ship 的失敗紀錄會把「輸出尾行」整段寫進 ship-evidence.md（進 git、永久留底），這段文字
// 來自被驗證指令自己的原始輸出，runner 管不到它有沒有夾帶密碼——落檔前先掃一遍常見樣式。
// 涵蓋兩類：①URL 內嵌帳密（postgres://user:pass@host、https://user:pass@host 這類）；
// ②鍵值對／Bearer 頭（token=／key=／password=／secret=／Authorization: Bearer <值>）。
// 只遮值不遮鍵名（沿用 verification-playbook「遮值不遮形」），方便看出是哪一類敏感值被遮了。
function redactSecrets(text) {
  if (!text) return text;
  return String(text)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1<REDACTED>@')
    .replace(/\bbearer\s+\S+/gi, 'Bearer <REDACTED>')
    .replace(/\b((?:api[_-]?)?(?:token|key|password|secret)[a-z0-9_-]*)\s*[:=]\s*\S+/gi, '$1=<REDACTED>');
}

// ---------------------------------------------------------------------------
// R2 斷路器：{cwd}/.constellation/.verify-state.json，per-target 連續失敗計數。
// 讀寫皆 fail-safe（讀不到/壞掉就當空狀態；寫不進去不擋主流程，斷路器降級但不 crash）。
// ---------------------------------------------------------------------------
const BREAKER_LIMIT = 5;
const stateFilePath = cwd => join(cwd, '.constellation', '.verify-state.json');

function readState(cwd) {
  try {
    const parsed = JSON.parse(stripBom(readFileSync(stateFilePath(cwd), 'utf8')));
    if (parsed && typeof parsed === 'object' && parsed.targets && typeof parsed.targets === 'object') return parsed;
  } catch {}
  return { targets: {} };
}

function writeState(cwd, state) {
  try { writeFileSync(stateFilePath(cwd), JSON.stringify(state, null, 2), 'utf8'); } catch {}
}

// 失敗：計數 +1、落盤、回傳新計數。
function recordFailure(cwd, target) {
  const state = readState(cwd);
  const cur = (Number(state.targets[target]) || 0) + 1;
  state.targets[target] = cur;
  writeState(cwd, state);
  return cur;
}

// 成功：計數歸零（只有原本非零才需要寫入，省一次 IO）。
function recordSuccess(cwd, target) {
  const state = readState(cwd);
  if (state.targets[target]) {
    state.targets[target] = 0;
    writeState(cwd, state);
  }
}

// 對抗複審 S9：舊訊息教人刪 .verify-state.json 重置計數，直接牴觸 phase-build.md「不得刪掉 runner
// 的失敗計數檔硬闖」——那等於把斷路器繞過。合法重置只有兩條路：這個目標後來驗證通過（自然歸零），
// 或 ship 目標由出貨歸檔移除 ship-evidence.md（新一輪判定，見上方 P15 說明），訊息改成講這兩條路。
function breakerTrippedMessage() {
  return '同一目標連續驗證失敗已達 5 次——停下來，把狀況整理給使用者拍板（換排查方向、或這張票標 blocked），不要再盲目重試；不得刪除 .constellation/.verify-state.json 硬闖，驗證通過後計數會自然歸零，ship 目標另以出貨歸檔移除 ship-evidence.md 重置';
}

// ---------------------------------------------------------------------------
// Y1 編碼保底：Windows 環境 spawnSync 用 encoding:'buffer' 拿原始位元組，先試 UTF-8 嚴格解碼
// （fatal:true，解不動就丟例外而非吃掉亂碼），失敗才退而用 latin1 保底解碼並加註記——
// 目的是「不 crash、不寫出無聲亂碼」，不是完美還原每種可能的 legacy codepage（cp950 等）。
// 使用者若能控制被跑的指令本身，最根本的解法仍是讓該指令自己輸出 UTF-8
// （例如指令前加 `chcp 65001 >nul &&`，或該工具本身的 UTF-8 輸出旗標）。
// ---------------------------------------------------------------------------
const DECODE_NOTE_UNREADABLE = '(非 UTF-8 輸出，已保底解碼，內容可能不完全可讀)';
const DECODE_NOTE_SKIPPED = '(輸出無法解碼，已略過)';

function decodeOutput(buf) {
  if (!buf || !buf.length) return { text: '', note: '' };
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return { text: decoder.decode(buf), note: '' };
  } catch {
    try {
      const text = Buffer.from(buf).toString('latin1');
      return { text, note: DECODE_NOTE_UNREADABLE };
    } catch {
      return { text: '', note: DECODE_NOTE_SKIPPED };
    }
  }
}

// ---------------------------------------------------------------------------
// S1 血緣殺：spawn（shell:true）＋自管逾時＋taskkill /T /F 殺整棵活樹（見檔頭說明）。
// ---------------------------------------------------------------------------
const MAX_BUF = 20 * 1024 * 1024; // 自行實作截斷：超過就從最舊的 chunk 丟起，保住尾段（證據只取尾 15 行）
const GRACE_AFTER_EXIT_MS = 2000; // 進程已退出後，最多再等這麼久讓管線把剩餘輸出吐完
const HARD_STOP_AFTER_KILL_MS = 10000; // 逾時殺完再等這麼久；taskkill 沒殺動就自己收尾，不無限等
// 6 小時總上限：不必設定，從指令開跑起算、不受資料重設影響，防「一直印卻永遠不結束」的失控指令。
// 測試逃生窗：CONSTELLATION_VERIFY_TEST_ABS_MAX_MS 環境變數可覆寫成更短的值——只給本檔的測試用，
// 不是使用者可設定的選項，不進 config.json、不進文件。
const ABSOLUTE_MAX_MS = (() => {
  const override = Number(process.env.CONSTELLATION_VERIFY_TEST_ABS_MAX_MS);
  return Number.isFinite(override) && override > 0 ? override : 6 * 60 * 60 * 1000;
})();
let currentChild = null; // 供 SIGINT 處理器殺掉當下這條指令的進程樹

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {}
}

// runner 自己被 Ctrl+C 時，盡力把當前指令樹一起帶走。子進程帶 windowsHide（沒有 console handle），
// 收不到父 console 的 Ctrl+C，所以這裡的 taskkill 是**唯一**機制、不是保底；若 runner 是被 taskkill /F
// 之類粗暴終止，本處理器根本不會執行，那層要靠 serve.mjs 的記帳起停兜底。
process.on('SIGINT', () => {
  killTree(currentChild && currentChild.pid);
  process.exit(130);
});

function makeSink() {
  const chunks = [];
  let total = 0;
  return {
    push(c) {
      chunks.push(c);
      total += c.length;
      while (total > MAX_BUF && chunks.length > 1) total -= chunks.shift().length;
    },
    buffer: () => {
      const b = Buffer.concat(chunks);
      // 丟掉最舊 chunk 後，保留段開頭可能落在多位元組 UTF-8 字元中間，會讓 decodeOutput 的嚴格
      // 解碼整段失敗、退到 latin1 亂碼。往前跳過續接位元組（0b10xxxxxx）對齊到字元起點。
      let i = 0;
      while (i < b.length && i < 3 && (b[i] & 0xc0) === 0x80) i++;
      return i ? b.subarray(i) : b;
    },
  };
}

// 跑一條指令，回 { stdout, stderr, exitCode, timedOut, error, shellPid }。
// shellPid 是這條指令的外殼（cmd.exe）pid，S2 補刀的血緣判準要靠它認「這是我起的」。
// onSpawn（可選）：外殼一 spawn 就拿到 pid 時立刻回呼——ship 範圍拿它更新機器鎖登記的
// 「目前子指令外殼 pid」（見 main() 呼叫處），與這條指令本身的執行邏輯無關，失敗不影響驗證。
function runCommand(cmd, cwd, timeoutMs, onSpawn) {
  return new Promise(res => {
    const out = makeSink();
    const err = makeSink();
    let done = false, exited = false, endedStreams = 0, timedOut = false, hitAbsoluteMax = false, exitCode = 1, spawnError = null;
    let idleTimer = null, absoluteTimer = null, graceTimer = null, hardStopTimer = null;

    const child = spawn(cmd, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], // stdin 直接關掉，指令不會卡在等輸入
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', LANG: 'C.UTF-8' },
    });
    currentChild = child;
    if (onSpawn) { try { onSpawn(child.pid); } catch {} }

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(idleTimer);
      clearTimeout(absoluteTimer);
      clearTimeout(graceTimer);
      clearTimeout(hardStopTimer);
      // 放棄等待後主動關掉管線：孤兒若還在輸出，下次寫入會拿到 EPIPE，runner 也不會繼續替它
      // 收到 MAX_BUF 上限。
      try { child.stdout.destroy(); child.stderr.destroy(); } catch {}
      currentChild = null;
      res({ stdout: out.buffer(), stderr: err.buffer(), exitCode, timedOut, hitAbsoluteMax, error: spawnError, shellPid: child.pid });
    };

    // 逾時的共用收尾：殺整棵活樹；taskkill 殺不動（提權子進程、taskkill 不在 PATH、防毒攔截）時
    // 'exit' 永遠不來，排一道保險期限到期自己結算，逾時路徑一定會回來。absolute=true 代表撞到的是
    // 6 小時總上限，不是無輸出逾時——兩者共用同一套殺樹與結算邏輯，只差 hitAbsoluteMax 這個旗標。
    // 對抗複審 S5：無輸出計時器與總上限計時器互斥——已經判定過逾時就直接返回，不重複殺樹／改判
    // 逾時原因；並在判定的同一刻清掉另一顆還沒觸發的計時器，不讓它晚點又補一刀。
    const onTimeout = absolute => {
      if (timedOut) return;
      timedOut = true;
      hitAbsoluteMax = absolute;
      clearTimeout(idleTimer);
      clearTimeout(absoluteTimer);
      killTree(child.pid);
      hardStopTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        finish();
      }, HARD_STOP_AFTER_KILL_MS);
    };

    // 無輸出逾時計時器：每收到一段 stdout／stderr 就重設（見下方 onData）；timeoutMs 即 config 的
    // timeoutSec，語意是「連續多久沒有輸出」，不是從開跑算起的總時長。
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => onTimeout(false), timeoutMs);
    };
    armIdleTimer();
    // 6 小時總上限：不受資料重設影響，從指令開跑起算，只是防呆，正常情況不指望會撞到。
    absoluteTimer = setTimeout(() => onTimeout(true), ABSOLUTE_MAX_MS);

    const onData = sink => c => {
      sink.push(c);
      if (!exited && !timedOut) armIdleTimer(); // 已結束或已判定逾時後才到的資料，不重新上膛
    };
    child.stdout.on('data', onData(out));
    child.stderr.on('data', onData(err));
    const onStreamEnd = () => { endedStreams++; if (exited && endedStreams >= 2) finish(); };
    child.stdout.on('end', onStreamEnd);
    child.stderr.on('end', onStreamEnd);

    child.on('error', e => { spawnError = e; exitCode = 1; exited = true; finish(); });
    child.on('exit', code => {
      exited = true;
      // 進程已退出就停掉兩顆逾時計時器：後面還有最多 2 秒寬限窗口，計時器留著會誤報「逾時」
      // （誤導 debug 方向）並對已死的 pid 再打一次 taskkill。
      clearTimeout(idleTimer);
      clearTimeout(absoluteTimer);
      exitCode = code == null ? 1 : code; // 被訊號殺掉時 code 為 null，一律當失敗
      if (endedStreams >= 2) finish();
      else graceTimer = setTimeout(finish, GRACE_AFTER_EXIT_MS);
    });
  });
}

// ---------------------------------------------------------------------------
// S2 埠差集補刀：抓外殼已退出、卻把 server 留下的孤兒（見檔頭說明）。
// ---------------------------------------------------------------------------
const REAP_ENABLED = process.platform === 'win32';
const portOf = key => { const i = key.lastIndexOf(':'); return i < 0 ? '' : key.slice(i + 1); };

// 一次 netstat -ano 拿 IPv4＋IPv6 全部 LISTENING，回 Map<"位址:埠", pid>；失敗回 null（該輪跳過補刀）。
function snapshotListeners() {
  if (!REAP_ENABLED) return null;
  try {
    const r = spawnSync('netstat', ['-ano'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    if (r.status !== 0 || !r.stdout) return null;
    const map = new Map();
    for (const line of r.stdout.toString('latin1').split(/\r?\n/)) {
      const p = line.trim().split(/\s+/);
      if (p.length < 5 || p[0] !== 'TCP' || p[3] !== 'LISTENING') continue;
      map.set(p[1], p[4]);
    }
    return map;
  } catch {
    return null;
  }
}

// 查全機進程表（只在候選非 0 時才付這次 PowerShell 的成本）。
// 回 Map<pid, { created: epoch ms, ppid, cmdline }>；查不到的 pid 不會出現在 Map 裡（呼叫端一律不動）。
// 為什麼是全機而不是只查候選：血緣判準要沿 ParentProcessId 鏈往上走好幾跳，逐跳各查一次要付好
// 幾次 PowerShell 冷啟。查詢用 -Property 只限定需要的 4 個欄位——實測貴的是「沒限定欄位、把每個
// 進程全部屬性都抓回來」（約 6–10 秒），限定後約 3.5–5 秒；掃描量本身（全機 440 進程約 170KB）不是成本大頭。
function queryProcessTable() {
  const script =
    `$r=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine | ` +
    `Select-Object ProcessId,ParentProcessId,@{n='Created';e={$_.CreationDate.ToUniversalTime().ToString('o')}},CommandLine); ` +
    `ConvertTo-Json -InputObject $r -Compress`;
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
    const txt = String(r.stdout || '').trim();
    if (!txt) return new Map();
    const data = JSON.parse(txt);
    const map = new Map();
    for (const it of Array.isArray(data) ? data : [data]) {
      if (!it || it.ProcessId == null) continue;
      const created = Date.parse(it.Created);
      map.set(String(it.ProcessId), {
        created: Number.isNaN(created) ? NaN : created,
        ppid: Number(it.ParentProcessId),
        cmdline: it.CommandLine || '',
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

// serve.mjs 的登記檔（.constellation/.servers.json）裡的 pid／外殼 pid：那些 server 由 serve.mjs 的
// stop／SessionEnd 負責收，補刀一律不碰，否則兩層機制互打（驗證指令用 serve.mjs start 起的 server 會被
// 下一次補刀殺掉，後續指令拿到假紅燈，登記檔還留一筆鬼魂）。讀不到／格式壞掉一律當空集合，不擋主流程。
function registeredPids(cwd) {
  const pids = new Set();
  try {
    const list = JSON.parse(stripBom(readFileSync(join(cwd, '.constellation', '.servers.json'), 'utf8')));
    if (Array.isArray(list)) {
      for (const e of list) {
        if (e && e.pid != null) pids.add(String(e.pid));
        if (e && e.shellPid != null) pids.add(String(e.shellPid));
      }
    }
  } catch {}
  return pids;
}

// 血緣判準：候選進程必須沿 ParentProcessId 鏈往上走得回本條指令的外殼 pid，才算「這是我起的」。
// Windows 在父進程死後仍保留子進程的 ParentProcessId 欄位值，所以外殼早就退出（`start /b` 的
// cmd、detached spawn 的中間層）照樣追得回來——這正是埠差集抓得到、而「父進程還活著嗎」判不出來
// 的那一類孤兒。鏈上每一跳（含候選自己）的建立時間都必須晚於本條指令開始：pid 被系統重新發出後，
// 新進程的 ParentProcessId 可能剛好等於本條指令的外殼 pid，時間檢查把這種假鏈夾掉。
// 往上走到「不在表裡的 pid」（中間層自己也退出了）、建立時間對不上、或超過 10 跳，一律判定不是
// 我起的、不殺——別的專案／session／worktree 的孤兒都停在這裡。
const MAX_LINEAGE_HOPS = 10;

function isOwnDescendant(pid, shellPid, table, cmdStartMs) {
  const shell = Number(shellPid);
  if (!Number.isInteger(shell) || shell <= 0) return false; // 沒有外殼 pid（spawn 就失敗）＝沒起過東西
  let cur = String(pid);
  for (let hop = 0; hop < MAX_LINEAGE_HOPS; hop++) {
    const node = table.get(cur);
    if (!node) return false;
    if (!(node.created >= cmdStartMs)) return false; // NaN（建立時間解析不出來）也走這條，不殺
    if (node.ppid === shell) return true;
    cur = String(node.ppid);
  }
  return false;
}

// 命令列太長時保留頭尾：開頭看得出是哪個執行檔，結尾才是能辨識身分的 script 名與參數
// （只印開頭的話，node.exe 絕對路徑加長專案路徑會把 script 名整個吃掉；誤殺時這行是唯一線索）。
function briefCmd(s) {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  return t.length <= 110 ? t : `${t.slice(0, 30)}…${t.slice(-70)}`;
}

// 差集比對＋四道豁免（白名單埠／serve.mjs 登記／建立時間／血緣）＋殺＋複驗。
// before/after 任一為 null（非 Windows／netstat 失敗）就整個跳過。
function reapOrphanServers(before, after, cmdStartMs, protectedPorts, cwd, shellPid) {
  if (!before || !after) return;
  const registered = registeredPids(cwd);
  const suspects = [];
  for (const [key, pid] of after) {
    if (before.get(key) === pid) continue; // key 沒變且 pid 沒變 → 本來就在
    if (protectedPorts.has(portOf(key))) continue;
    if (registered.has(pid)) continue; // serve.mjs 記帳管著的，不歸補刀處理
    suspects.push({ key, pid });
  }
  if (!suspects.length) return;

  const info = queryProcessTable();
  const killed = new Set();
  for (const { key, pid } of suspects) {
    if (killed.has(pid)) continue;
    const p = info.get(pid);
    if (!p) continue; // 查不到（已消失／查詢失敗）→ 不動
    if (!(p.created >= cmdStartMs)) continue; // 建立時間早於本條指令開始 → 不是這條起的，不殺
    if (!isOwnDescendant(pid, shellPid, info, cmdStartMs)) continue; // 血緣追不回本條指令的外殼 → 不是我起的，不殺
    killed.add(pid);
    killTree(pid);
    console.error(`清掉殘留 server：port ${portOf(key)} PID ${pid}（${briefCmd(p.cmdline)}）`);
  }
  if (!killed.size) return;

  const verify = snapshotListeners();
  if (!verify) return;
  for (const { key, pid } of suspects) {
    if (killed.has(pid) && verify.get(key) === pid) {
      console.error(`⚠ 殘留 server 未釋放：port ${portOf(key)} PID ${pid} 仍在 LISTENING`);
    }
  }
}

function ticketTitle(raw) {
  for (const l of String(raw).split(/\r?\n/)) {
    const t = l.trim();
    if (t.startsWith('#')) return t.replace(/^#+\s*/, '').trim();
  }
  return '';
}

// 把一筆驗證證據 append 進「## 驗證證據」section 的尾端（沒有該 section 就自動補在檔尾）。
// ticket 票檔與 ship-evidence.md 共用這支函式——DESIGN 明定 ship 級證據筆格式與票內完全相同。
function appendEvidence(content, entryText) {
  // 只認「驗證證據」開頭即可，不要求整行只有這四個字——實際模板標題帶括號說明文字
  // （如「## 驗證證據（關票時由 runner 寫入...）」），要求整行精確符合會漏配，重複補一個新 heading。
  const headingMatch = content.match(/^##\s*驗證證據.*$/m);
  if (!headingMatch) {
    const sep = content.endsWith('\n') ? '' : '\n';
    return `${content}${sep}\n## 驗證證據\n\n${entryText}\n`;
  }
  const afterHeading = headingMatch.index + headingMatch[0].length;
  const rest = content.slice(afterHeading);
  const nextHeading = rest.match(/\n##\s/);
  const sectionEnd = nextHeading ? afterHeading + nextHeading.index : content.length;
  const before = content.slice(0, sectionEnd);
  const after = content.slice(sectionEnd);
  const needsNL = before.endsWith('\n') ? '' : '\n';
  return `${before}${needsNL}${entryText}\n${after}`;
}

// ship-evidence.md 的預設檔頭（檔案還不存在時才用）——成功路徑與失敗紀錄路徑共用同一份字面字串，
// 避免兩處各自維護一份、日後改動時兜不起來。
const SHIP_EVIDENCE_HEADER =
  '# Constellation 出貨驗證證據\n\n> 由 `verify-runner.mjs --scope ship` 寫入，證據筆格式與票內完全相同（見 DESIGN.md §5）。\n';

function readShipEvidenceOrInit(shipEvidencePath) {
  return existsSync(shipEvidencePath) ? stripBom(readFileSync(shipEvidencePath, 'utf8')) : SHIP_EVIDENCE_HEADER;
}

// 失敗路徑專用（僅 --scope ship）：把本輪已跑過的指令（含剛失敗的這條）整理成一段「## 失敗紀錄」，
// 直接 append 在 ship-evidence.md 檔尾——不進「## 驗證證據」section、不簽章。純追查用途：關票／出貨
// 判定一律只認上面帶 sig 的「## 驗證證據」筆，這段不參與判定，也不會被 close-gate／commit-gate 的
// 證據行解析誤讀（那兩支只找「## 驗證證據」section 底下的列項）。
function appendFailureRecord(content, entryText) {
  const sep = content.endsWith('\n') ? '' : '\n';
  return `${content}${sep}\n${entryText}\n`;
}

// ---------------------------------------------------------------------------
// 跨 session 出貨鎖（決議 026、033，見 gates/lease.mjs 檔頭）：--scope ship 開跑前搶「本專案」那一把鎖，
// 被同專案的別人佔著就排隊等對方跑完（同專案同時跑整套會互刪資料、互殺行程）；別的專案持有不排隊。
// ---------------------------------------------------------------------------
const LEASE_MAX_WAIT_SEC_DEFAULT = 4 * 60 * 60; // 4 小時
// 測試逃生窗（同 CONSTELLATION_VERIFY_TEST_ABS_MAX_MS 的用法）：只給本檔測試覆寫成毫秒級，
// 不進 config.json、不是使用者可設定的選項。
const LEASE_POLL_MS = Number(process.env.CONSTELLATION_LEASE_TEST_POLL_MS) || 5000;
const LEASE_STATUS_MS = Number(process.env.CONSTELLATION_LEASE_TEST_STATUS_MS) || 10 * 60 * 1000;
// 登記檔壞掉（讀不出來但檔案還在）卡超過這麼久才當失效處理——太短會跟「正在寫入的瞬間」誤判，
// 太長會讓真的壞掉的登記卡住整輪 ship（見 lease.mjs 的 invalidateCorrupt）。同款測試逃生窗。
const CORRUPT_STALE_MS = Number(process.env.CONSTELLATION_LEASE_TEST_CORRUPT_STALE_MS) || 30_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 子孫重入判定：環境變數放的是「目前登記持有者的 pid:startedAt」而不是單純的 '1'——只放 '1' 的話，
// 任何**單純繼承到這個變數**的行程（例如這支測試殼層剛好沿用了舊環境、或這支 runner 本身被當成
// 別人 commands.test 的一部分跑）都會被誤判成「已持有」而完全跳過搶鎖，鎖形同虛設。改放身分字串後，
// 只有「目前登記檔真的是這把旗標指的那一筆」才算重入；查不到那份登記（不管是沒人持有還是換了人）
// 就必須照正常流程重新搶。
const LEASE_ENV_FLAG = 'CONSTELLATION_LEASE_ACQUIRED';
const leaseFlagFor = identity => `${identity.pid}:${identity.startedAt}`;
function isReentrantLease(key) {
  const flag = process.env[LEASE_ENV_FLAG];
  if (!flag) return false;
  const holder = readHolder(key);
  return !!holder && flag === `${holder.pid}:${holder.startedAt}`;
}

// 不排隊，只提醒一行（規格要求一行）：逐票驗證、以及出貨全量開跑時與紅燈收尾時，讀「所有專案」的登記，
// 有別人持有出貨鎖就印；順手帶上「紅了怎麼辦」的行動指引，不用另外去 lease list 查。自己（pid 相同）
// 與自己的祖先持有者（環境變數旗標對得上，子孫重入）不必提醒自己。
function noteShipLeaseIfHeld() {
  const flag = process.env[LEASE_ENV_FLAG];
  for (const { holder } of listHolders()) {
    if (!holder || !isPidAlive(holder.pid) || holder.pid === process.pid || flag === `${holder.pid}:${holder.startedAt}`) continue;
    console.error(
      `提醒：出貨鎖目前被別的出貨全量持有中（${holder.root || '不明專案'}，PID ${holder.pid}）——` +
      '本次驗證不受影響、照跑；若這次紅了，先等對方結束再重跑一次判定。'
    );
  }
}

// 開跑前搶本專案的出貨鎖；被同專案的別人佔著就排隊等，逾時（預設 4 小時）用代碼 3 結束——不計入斷路器、
// 不寫失敗紀錄，因為這不是驗證失敗，只是同專案的出貨一直被佔用。回傳識別物件 { key, pid, startedAt }
// （供收尾釋放比對）；null 代表不必釋放（子孫重入，或登記目錄寫不進去已 fail-open 照跑）。
async function acquireShipLease(cwd, maxWaitSec) {
  const key = projectKey(cwd);
  if (isReentrantLease(key)) return null; // 子孫重入：視為已持有，不再搶、不用釋放

  const identity = { key, pid: process.pid, startedAt: myStartedAtMs() }; // 全程只算一次，見 lease.mjs 檔頭說明
  const entry = {
    key,
    root: cwd,
    session: process.env.CODEX_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || 'unknown',
    runtime: process.env.CODEX_SESSION_ID ? 'codex' : process.env.CLAUDE_CODE_SESSION_ID ? 'claude' : 'unknown',
    pid: identity.pid,
    startedAt: identity.startedAt,
    purpose: 'ship 全量驗證',
    estimatedEndAt: null,
    grantedAt: null,
    shellPid: null,
  };
  // 每次真的嘗試搶鎖前才重算「預估結束時間」與「grantedAt」（真正搶到的那一刻）——排隊排了很久
  // 的話，進場那一刻算的估計值輪到時早就過期，一定要在最終寫進登記檔的那次呼叫前重算才準
  // （見 lease.mjs 檔頭）；grantedAt 同時也是守門訊息「起於 HH:MM」該顯示的時間，不是排隊起點。
  function tryAcquire() {
    entry.estimatedEndAt = estimateEndFromShipEvidence(cwd);
    entry.grantedAt = Date.now();
    return acquireLease(key, entry);
  }

  let result;
  try {
    result = tryAcquire();
  } catch (err) {
    console.error(`⚠ 機器鎖登記目錄寫不進去（${err && err.message ? err.message : err}），本輪不排隊，直接照跑（視為已開跑）。`);
    return null; // fail-open：沒有東西要釋放
  }
  if (result.ok) {
    console.error('機器鎖無人佔用，開跑。'); // 這一行本身就是「開跑」訊號，見 phase-ship.md 步驟 1
    process.env[LEASE_ENV_FLAG] = leaseFlagFor(identity);
    return identity;
  }

  const deadline = Date.now() + maxWaitSec * 1000;
  let announced = false;
  let lastStatusAt = 0;
  // 初始化成 Date.now()、不是 0：這是「上次做過較貴檢查」的時間戳，從 0（等同 1970 年）起算的話，
  // 第一輪迴圈只要持有者還活著就會立刻判定「已經超過 LEASE_STATUS_MS 沒做」而馬上觸發一次
  // queryProcessTable()（實測會呼叫 PowerShell 枚舉全機行程，動輒數秒）——等於每次排隊一開始就
  // 平白多等好幾秒，跟這個檢查本來要「每隔 LEASE_STATUS_MS 才多付一次」的設計意圖相反，
  // 短 --max-wait 時足以把預算耗光而誤判逾時（wave5 對抗複審 S6 測試案例踩過這個坑）。
  let lastHeavyCheckAt = Date.now();
  let corruptSince = null; // 第一次看到「登記檔在但讀不出來」的時間

  for (;;) {
    if (result.corrupt) {
      // 登記檔存在但解析不出來（多半是寫到一半被打斷，如 taskkill／TaskStop 打在寫檔中途）：
      // 不能沿用下面的 invalidateLease()——它靠比對 pid／startedAt 判斷「是不是原本那一筆」，
      // 壞檔案沒有這個身分可比，會誤判成「已經被清掉」而不動手，讓壞檔案卡住不放。
      if (corruptSince == null) corruptSince = Number.isFinite(result.mtimeMs) ? result.mtimeMs : Date.now();
      if (!announced) {
        console.error(`機器鎖登記檔讀不出來（可能正寫到一半），先等最多 ${Math.round(CORRUPT_STALE_MS / 1000)} 秒再視同失效重搶。`);
        announced = true;
      }
      if (Date.now() - corruptSince >= CORRUPT_STALE_MS) {
        invalidateCorruptLease(key);
        corruptSince = null;
      }
      if (Date.now() >= deadline) {
        console.error(`等了 ${Math.round(maxWaitSec / 60)} 分鐘機器鎖登記檔仍讀不出來，先停下（代碼 3，不計入斷路器）。`);
        process.exit(3);
      }
      await sleep(LEASE_POLL_MS);
      result = tryAcquire();
      if (result.ok) {
        console.error('機器鎖搶到了，開跑。');
        process.env[LEASE_ENV_FLAG] = leaseFlagFor(identity);
        return identity;
      }
      continue;
    }

    const holder = result.holder;
    if (!holder) {
      // holder 讀不到，且不是上面的「壞掉」分支：檔案剛好在這個瞬間消失（被釋放或被別人判失效）。
      result = tryAcquire();
      if (result.ok) {
        // 原持有者正常結束（release() 把登記檔刪了）而不是判失效——這是排隊等待最常見的收尾方式，
        // 同樣要印「開跑」：這一行是主 session 用來判斷「還能不能中途砍」的訊號（見 phase-ship.md
        // 步驟 1），不論先前有沒有真的排過隊都要印，沒有這行就沒有訊號可看。
        console.error('機器鎖搶到了，開跑。');
        process.env[LEASE_ENV_FLAG] = leaseFlagFor(identity);
        return identity;
      }
      if (Date.now() >= deadline) process.exit(3);
      await sleep(LEASE_POLL_MS);
      continue;
    }

    if (!announced) {
      console.error(`機器鎖被佔用，排隊等待——\n${formatHolder(holder)}`);
      announced = true;
      lastStatusAt = Date.now();
    }

    // 失效判定：先用零成本的 pid 存活檢查；每隔 LEASE_STATUS_MS（預設 10 分鐘）才多付一次較貴的
    // 「行程建立時間」比對——防 PID 被系統回收後接出一個剛好同號的無關行程（決議 020 同一套顧慮）。
    // 兩個時間來源不同（這裡記的是 JS 端用 uptime 反推的估計值，比對的是 CIM 查到的實際建立時間），
    // 允許 2 秒的量測誤差，不要求毫秒級精確相等。
    let stale = !isPidAlive(holder.pid);
    if (!stale && Date.now() - lastHeavyCheckAt >= LEASE_STATUS_MS) {
      lastHeavyCheckAt = Date.now();
      const info = queryProcessTable().get(String(holder.pid));
      if (info && Number.isFinite(info.created) && Number.isFinite(holder.startedAt)) {
        stale = Math.abs(info.created - holder.startedAt) > 2000;
      }
    }

    if (stale) {
      invalidateLease(key, holder);
      result = tryAcquire();
      if (result.ok) {
        console.error('原持有者已失效，機器鎖搶到了，開跑。');
        process.env[LEASE_ENV_FLAG] = leaseFlagFor(identity);
        return identity;
      }
      // 只有真的換了新持有者才重新印一次「排隊等待」——invalidate 沒生效時（例如短暫的
      // EPERM/EBUSY）現在的登記還是同一個持有者，不必也不該再印一次一模一樣的內容。
      const stillSame = result.holder &&
        Number(result.holder.pid) === Number(holder.pid) &&
        Number(result.holder.startedAt) === Number(holder.startedAt);
      if (!stillSame) announced = false;
      if (Date.now() >= deadline) {
        console.error(`等了 ${Math.round(maxWaitSec / 60)} 分鐘機器鎖仍被佔用，先停下（代碼 3，不計入斷路器）：\n${formatHolder(result.holder || holder)}`);
        process.exit(3);
      }
      // 失效改名可能一直失敗（EPERM/EBUSY 或更罕見的原因），務必先讓出時間、也一定要先過
      // deadline 檢查才 continue——否則會變成一個不 sleep 也不看逾時的空轉緊迴圈（S3）。
      await sleep(LEASE_POLL_MS);
      continue;
    }

    if (Date.now() >= deadline) {
      console.error(`等了 ${Math.round(maxWaitSec / 60)} 分鐘機器鎖仍被佔用，先停下（代碼 3，不計入斷路器）：\n${formatHolder(holder)}`);
      process.exit(3);
    }

    await sleep(LEASE_POLL_MS);
    if (Date.now() - lastStatusAt >= LEASE_STATUS_MS) {
      lastStatusAt = Date.now();
      console.error(`仍在排隊等機器鎖——\n${formatHolder(holder)}`);
    }
    // 這裡只是被動重新整理現況，不能換成 tryAcquire()：tryAcquire() 若剛好在這一刻成功搶到鎖，
    // 回傳的是 `{ ok: true }`（沒有 holder 欄位），下一輪迴圈頂端的 `if (!holder)` 會誤判成
    // 「現在沒人持有」而再搶一次——這次一定撞到自己剛寫下的登記而失敗，等於在等自己，直到
    // 逾時退出、還留下一份沒人釋放的孤兒登記（wave5 對抗審查曾在此踩過一次）。
    result = peekHolder(key);
  }
}

async function main() {
  const { ticket, cwd: cwdArg, scope: scopeArg, maxWait: maxWaitArg } = parseArgs(process.argv.slice(2));
  const scope = scopeArg || 'ticket';
  if (scope !== 'ticket' && scope !== 'ship') {
    console.error(`--scope 只能是 ticket 或 ship（收到："${scopeArg}"）`);
    process.exit(1);
  }
  const cwd = cwdArg ? resolve(cwdArg) : findProjectRoot(process.cwd());

  // 跨 session 出貨鎖：ship 開跑前搶本專案的鎖、被同專案的別人佔著就排隊；兩種範圍開跑時都提醒一行別人持有的鎖（不排隊）。
  let shipLeaseIdentity = null;
  if (scope === 'ship') {
    const maxWaitSec = Number(maxWaitArg) > 0 ? Number(maxWaitArg) : LEASE_MAX_WAIT_SEC_DEFAULT;
    shipLeaseIdentity = await acquireShipLease(cwd, maxWaitSec);
    if (shipLeaseIdentity) {
      // 一處同步釋放，涵蓋所有 process.exit 出口，不必逐一改；釋放前比對識別碼（見 lease.mjs release）。
      process.on('exit', () => { releaseLease(shipLeaseIdentity.key, shipLeaseIdentity); });
    }
  }
  noteShipLeaseIfHeld();

  let ticketPath = '';
  let target = '';
  if (scope === 'ticket') {
    if (!ticket) {
      console.error('用法：node verify-runner.mjs --ticket <票路徑或純票號> [--cwd <專案根>] [--scope ticket]');
      process.exit(1);
    }
    ticketPath = resolveTicketPath(cwd, ticket);
    target = ticketRelPath(ticketPath);
  } else {
    target = 'ship';
    // ship 斷路器新一輪判定：ship-evidence.md 不存在（剛歸檔完或第一次跑）就先把計數歸零——
    // 手動刪掉這個檔等同刪計數檔硬闖，不是合法繞過（見上方 R2 說明、phase-build.md）。
    if (!existsSync(join(cwd, '.constellation', 'ship-evidence.md'))) recordSuccess(cwd, target);
  }

  const configPath = join(cwd, '.constellation', 'config.json');
  let config = {};
  try { config = JSON.parse(stripBom(readFileSync(configPath, 'utf8'))); } catch {
    console.error(`讀不到或解析失敗：${configPath}（需要 commands.test／commands.journey 才知道要跑什麼指令）`);
    process.exit(1);
  }
  const commandsCfg = config.commands || {};
  let commands;
  let scopedCount = 0;
  if (scope === 'ticket') {
    const scoped = parseScopedCommands(stripBom(readFileSync(ticketPath, 'utf8')), ticketPath);
    if (scoped.length) {
      commands = scoped;
      scopedCount = scoped.length;
      console.log(`票級縮圈：跑票內「驗證指令」${scopedCount} 條（取代 config 全量；出貨 --scope ship 仍跑全量）。`);
    } else {
      commands = toCommandList(commandsCfg.test);
    }
  } else {
    commands = [...toCommandList(commandsCfg.test), ...toCommandList(commandsCfg.journey)];
  }
  if (!commands.length) {
    const which = scope === 'ticket' ? 'commands.test' : 'commands.test／commands.journey';
    console.error(`${configPath} 的 ${which} 都是空的——沒有指令可驗證。補上指令，或這張票該標 blocked（見 phase-weave.md）。`);
    process.exit(1);
  }

  const timeoutSec = Number(config.timeoutSec);
  const timeoutMs = (Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : 600) * 1000;

  // protectedPorts：config 可選的白名單埠（陣列），S2 補刀一律跳過這些埠。
  const protectedPorts = new Set((Array.isArray(config.protectedPorts) ? config.protectedPorts : []).map(String));

  const results = [];
  const scopeStartMs = Date.now();
  let beforeSnap = snapshotListeners();
  for (let cmdIndex = 0; cmdIndex < commands.length; cmdIndex++) {
    const cmd = commands[cmdIndex];
    const cmdStartMs = Date.now();
    const onSpawn = shipLeaseIdentity ? pid => updateLeaseShellPid(shipLeaseIdentity.key, shipLeaseIdentity, pid) : undefined;
    const r = await runCommand(cmd, cwd, timeoutMs, onSpawn);
    const durSec = Math.round((Date.now() - cmdStartMs) / 1000);
    // 每條指令跑完就 reap（含逾時、含失敗）——下面所有 process.exit 出口因此都已清乾淨。
    const afterSnap = snapshotListeners();
    reapOrphanServers(beforeSnap, afterSnap, cmdStartMs, protectedPorts, cwd, r.shellPid);
    beforeSnap = afterSnap; // 前一條的 after 直接當下一條的 before
    const outDecoded = decodeOutput(r.stdout);
    const errDecoded = decodeOutput(r.stderr);
    const timedOut = r.timedOut;
    const exitCode = r.error ? 1 : r.exitCode;
    if (exitCode !== 0) {
      console.error(`驗證失敗：\`${cmd}\`（exit ${exitCode}，${durSec}s）`);
      if (timedOut) {
        console.error(
          r.hitAbsoluteMax
            ? `逾時：已達 6 小時總執行時間上限（${Math.round(ABSOLUTE_MAX_MS / 1000)} 秒），已強制終止該指令。`
            : `逾時：超過 ${timeoutMs / 1000} 秒沒有任何輸出，已強制終止該指令。`,
        );
      }
      if (r.error) console.error(`spawn 錯誤：${r.error.message}`);

      // 遇到第一條紅燈即停：後面排隊的指令不會執行，清單只涵蓋這一條（phase-ship.md／
      // phase-build.md 同款措辭）——不是「一次紅燈跑完就等於拿到所有壞掉項目的完整清單」。
      const notRun = commands.slice(cmdIndex + 1);
      if (notRun.length) {
        console.error(`以下指令因前一條紅燈未執行：${notRun.map(c => `\`${c}\``).join('、')}`);
      }

      // 完整輸出先試著存檔（同一 repo＋target 覆寫，不累積）；主控台只印最後 40 行，避免長輸出把
      // harness 的預覽塞滿、逼模型自己接 `| tail` 把退出碼吃掉。寫檔失敗（暫存目錄不可寫等）就
      // 退回印完整輸出，至少不會連線索都沒有。
      let failureLog = '';
      try {
        const logPath = failureLogPath(cwd, target);
        mkdirSync(dirname(logPath), { recursive: true });
        const combined =
          `--- stdout ---\n${outDecoded.text}${outDecoded.note ? `\n${outDecoded.note}` : ''}\n` +
          `--- stderr ---\n${errDecoded.text}${errDecoded.note ? `\n${errDecoded.note}` : ''}`;
        writeFileSync(logPath, combined, 'utf8');
        failureLog = logPath;
      } catch {}

      if (failureLog) {
        console.error('--- stdout（最後 40 行） ---');
        console.error(tail(outDecoded.text, 40));
        if (outDecoded.note) console.error(outDecoded.note);
        console.error('--- stderr（最後 40 行） ---');
        console.error(tail(errDecoded.text, 40));
        if (errDecoded.note) console.error(errDecoded.note);
        console.error(`完整輸出：${failureLog}`);
      } else {
        console.error('--- stdout ---');
        console.error(outDecoded.text);
        if (outDecoded.note) console.error(outDecoded.note);
        console.error('--- stderr ---');
        console.error(errDecoded.text);
        if (errDecoded.note) console.error(errDecoded.note);
      }

      if (scope === 'ship') {
        const failTs = new Date().toISOString();
        const failLastLine = redactSecrets(lastNonBlankLine(outDecoded.text) || lastNonBlankLine(errDecoded.text));
        const failLines = [`## 失敗紀錄 ${failTs}`, ''];
        for (const pr of results) {
          failLines.push(`- \`${pr.cmd}\`（exit 0，${pr.durSec}s）：${redactSecrets(pr.realLastLine) || '(空)'}`);
        }
        failLines.push(`- \`${cmd}\`（exit ${exitCode}，${durSec}s）：${failLastLine || '(空)'}`);
        failLines.push('');
        failLines.push('未簽章：此段僅供追查耗時與髒資料來源，不參與關票與出貨判定。');
        const shipEvidencePath = join(cwd, '.constellation', 'ship-evidence.md');
        try {
          const existingShip = readShipEvidenceOrInit(shipEvidencePath);
          writeFileSync(shipEvidencePath, appendFailureRecord(existingShip, failLines.join('\n')), 'utf8');
        } catch (e) {
          console.error(`⚠ 失敗紀錄寫入 ${shipEvidencePath} 失敗，已略過（不影響斷路器計數與退出碼）：${e && e.message ? e.message : e}`);
        }
      }

      if (scope === 'ship') noteShipLeaseIfHeld(); // 紅燈收尾再提醒一次：別專案的出貨若還在跑，先等它結束再單跑判定

      const failCount = recordFailure(cwd, target);
      if (failCount >= BREAKER_LIMIT) {
        console.error(`\nConstellation 驗證斷路器：${breakerTrippedMessage()}`);
        process.exit(2);
      }
      console.error(scope === 'ship' ? '未寫入驗證證據，這一輪不能出貨。' : '未寫入驗證證據，這張票不能標 done。');
      process.exit(1);
    }
    const realTailText = escapeEvidenceText(lastNonBlankLines(outDecoded.text, 8));
    // 註記獨立於 fenced block 之外（不混進去）：簽章的「輸出尾行」只認 block 內的真實內容，
    // 註記文字本身絕不能被誤當成輸出內容去參與簽章——兩者職責分開，關票刷卡機解析時才不會混淆。
    results.push({ cmd, durSec, realTailText, note: outDecoded.note, realLastLine: lastNonBlankLine(realTailText) });
  }

  // 全部通過 → 斷路器歸零 → 落證據（含簽章）
  recordSuccess(cwd, target);

  const ts = new Date().toISOString();
  const entryLines = [`- **${ts}**`];
  for (const r of results) {
    entryLines.push(`  - \`${r.cmd}\`（exit 0）`);
    if (r.note) entryLines.push(`    ${r.note}`);
    if (r.realTailText.trim()) {
      entryLines.push('    ```');
      for (const l of r.realTailText.split('\n')) entryLines.push(`    ${l}`);
      entryLines.push('    ```');
    }
  }
  // 耗時行：獨立一行、不帶反引號、不含「（exit」——close-gate／commit-gate 的證據行解析
  // （COMMAND_LINE_RE 行尾錨定「（exit N）」）天然忽略本行；儀表用途，不參與下方簽章運算。
  const totalSec = Math.round((Date.now() - scopeStartMs) / 1000);
  entryLines.push(`  - 耗時：合計 ${totalSec}s｜${results.map(r => `${r.cmd} ${r.durSec}s`).join('｜')}`);

  const secret = readSecret();
  if (secret) {
    const commandsJoined = results.map(r => r.cmd).join('\n');
    const lastCmdResult = results[results.length - 1];
    // 簽章用的「輸出尾行」取真正解碼後內容的最後非空白行（不含保底解碼註記那一行），
    // 這樣才是對「實際輸出內容」的指紋，不是對註記文字的指紋。
    const lastLine = lastCmdResult ? lastCmdResult.realLastLine : '';
    const repoRoot = repoRootToken(signingRoot(cwd)); // 決議 030：綁主工作樹根，跨 worktree 驗簽一致
    const sig = computeSignature(secret, ts, target, commandsJoined, lastLine, repoRoot);
    entryLines.push(`  - sig: ${sig}`);
  } else {
    console.warn(`警告：讀不到簽章 secret 檔（${SECRET_PATH}）——這筆證據將標記為 unsigned，關票刷卡機會擋下。`);
    console.warn('先跑 install.ps1 產生 secret 後再重跑本 runner，才能產生可過關的簽章證據。');
    entryLines.push('  - sig: unsigned');
  }

  const entryText = entryLines.join('\n');

  if (scope === 'ticket') {
    const raw = stripBom(readFileSync(ticketPath, 'utf8'));
    writeFileSync(ticketPath, appendEvidence(raw, entryText), 'utf8');
    const title = ticketTitle(raw) || basename(ticketPath);
    console.log(`驗證通過（${title}）：${results.length} 項指令全數 exit 0（總耗時 ${totalSec}s），證據已寫入 ${ticketPath}`);
  } else {
    const shipEvidencePath = join(cwd, '.constellation', 'ship-evidence.md');
    const existing = readShipEvidenceOrInit(shipEvidencePath);
    writeFileSync(shipEvidencePath, appendEvidence(existing, entryText), 'utf8');
    console.log(`出貨驗證通過：${results.length} 項指令（test＋journey 全量）全數 exit 0（總耗時 ${totalSec}s），證據已寫入 ${shipEvidencePath}`);
  }
  for (const r of results) console.log(`  - ${r.cmd}（exit 0，${r.durSec}s）`);
  process.exit(0);
}

main().catch(e => {
  console.error(`Constellation 驗證 runner 內部錯誤：${e && e.stack ? e.stack : e}`);
  killTree(currentChild && currentChild.pid);
  process.exit(1);
});
