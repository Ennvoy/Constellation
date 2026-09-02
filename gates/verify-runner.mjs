#!/usr/bin/env node
// Constellation 閘門 4 —— 驗證 runner（CLI，非 hook）。DESIGN.md §4／§5。
// 用法：
//   逐票：node verify-runner.mjs --ticket <票路徑或純票號> [--cwd <專案根>] [--scope ticket]
//   出貨：node verify-runner.mjs --scope ship [--cwd <專案根>]
// --scope ticket（預設）：要求 --ticket。票內有「## 驗證指令」section（weave 拆票時寫定的縮圈清單，
//   見 ticket-template.md）就跑該清單；沒有就跑 config 的 commands.test 全量——fallback 永遠是全量，
//   縮圈只因「票裡明寫了」而發生。證據寫回該票檔。
// --scope ship：不要求 --ticket，跑 commands.test＋commands.journey 全量（票內縮圈清單一律不看），
//   證據寫入 {cwd}/.constellation/ship-evidence.md（沒有這個檔就自動建立）。
// --ticket 可以給純票號（如 T-003）：先試直接路徑，找不到就在 .constellation/tickets/ 下
// glob `<票號>*.md`，唯一命中才用；零命中或多重命中一律報錯並列出候選，不猜。
// 全部指令 exit 0 才落一筆證據（時間戳＋各指令＋exit code＋stdout 尾 15 行）；任一失敗：印該指令
// 完整輸出、不寫證據、exit 1（或斷路器觸發時 exit 2）——證據不能靠人手填，必須是這支 runner 親自跑出來的。
// 證據筆另附一行各指令耗時（「- 耗時：合計 Ns｜…」，獨立行、不帶反引號、不含「（exit」）——close-gate／
// commit-gate 的證據行解析（COMMAND_LINE_RE 行尾錨定「（exit N）」）天然忽略本行；儀表用途，不參與簽章。
//
// R1 證據防偽：光「不能手填時間戳」不夠——時間戳本身也是純文字，手改票檔一樣能塞一個 24 小時內的
// ISO 字串。真正的防偽來自簽章：對「ISO 時間戳＋票檔相對路徑（或 "ship"）＋全部指令串接＋輸出尾行
// ＋repo 根絕對路徑」算 HMAC-SHA256（secret 只存在使用者家目錄、不進 git、不落 repo），證據筆尾附一行
// `sig: <hex>`。沒有這把 secret 就無法算出合法簽章，手填時間戳因此真的擋不過關票刷卡機（gates/close-gate.mjs）。
// repo 根這段是防「跨專案重放」——把另一個專案跑出來的合法證據筆整段複製貼到這個專案的票裡，簽章對不上。
// **鏡像提醒**：本檔的簽章建構邏輯（SECRET_PATH／ticketRelPath／FIELD_SEP／computeSignature／
// repoRootToken，以及簽章涵蓋的欄位定義）與 gates/close-gate.mjs 的驗簽邏輯、gates/commit-gate.mjs
// 的 done 票稽核驗簽邏輯必須逐字元一致，三檔各自內聯一份（不共用 import）——關票刷卡機與 commit 守門
// 是安全閘門，不依賴另一支腳本的存在／版本；改一份要同步改另兩份。
//
// 斷路器（R2）：{cwd}/.constellation/.verify-state.json 記 per-target（票相對路徑或 "ship"）連續失敗
// 計數；成功歸零、失敗 +1；達 5 次時 exit 2，請使用者拍板，不再盲目重試（見 recordFailure）。
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
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve, join, basename } from 'node:path';
import { createHmac } from 'node:crypto';
import { homedir } from 'node:os';

const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// ---------------------------------------------------------------------------
// R1 簽章（與 close-gate.mjs／commit-gate.mjs 鏡像，見檔頭說明）
// ---------------------------------------------------------------------------
const SECRET_PATH = join(homedir(), '.constellation', 'secret');

function readSecret() {
  try {
    const s = readFileSync(SECRET_PATH, 'utf8').trim();
    return s || null;
  } catch {
    return null;
  }
}

// 票檔的「相對識別路徑」：從絕對路徑裡截出 `.constellation/tickets/xxx.md` 這一段並統一用 `/`。
// 不依賴呼叫時的 cwd（cwd 不同、絕對路徑前綴不同，但這一段永遠一樣），兩邊腳本各自從自己拿到的
// 路徑字串獨立算出來，仍會得到同一個結果——這是簽章能跨檔驗證的關鍵前提。
function ticketRelPath(p) {
  const norm = String(p).replace(/\\/g, '/');
  const m = norm.match(/\.constellation\/tickets\/[^/]+\.md$/i);
  return m ? m[0] : norm;
}

// repo 根識別 token：path.resolve 正規化後轉小寫、反斜線轉正斜線——同一台機器上不同大小寫/斜線
// 風格寫法的同一個路徑，token 仍相同；不同專案的 cwd 一定不同，簽章因此天然綁定 repo（防跨專案重放）。
function repoRootToken(cwd) {
  return resolve(cwd).toLowerCase().replace(/\\/g, '/');
}

// 欄位分隔字元：一般文字與指令輸出裡幾乎不可能出現的控制字元（U+0001, SOH），
// 用來串接簽章的各欄位、避免欄位邊界混淆。三邊腳本的值與位置必須逐字元一致。
const FIELD_SEP = '\u0001';

// 簽章涵蓋欄位：ISO 時間戳、票檔相對路徑（或 "ship"）、全部指令以 '\n' 串接、輸出尾行（最後一個指令
// 的 tail 輸出裡最後一個非空白行；沒有輸出則為空字串）、repo 根絕對路徑 token。
function computeSignature(secret, ts, relPath, commandsJoined, lastLine, repoRoot) {
  const payload = [ts, relPath, commandsJoined, lastLine, repoRoot].join(FIELD_SEP);
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function parseArgs(argv) {
  const out = { ticket: '', cwd: '', scope: 'ticket' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ticket') out.ticket = argv[++i] || '';
    else if (argv[i] === '--cwd') out.cwd = argv[++i] || '';
    else if (argv[i] === '--scope') out.scope = argv[++i] || '';
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

function breakerTrippedMessage() {
  return '同一目標連續驗證失敗已達 5 次——停下來，把狀況整理給使用者拍板，不要再盲目重試（要重置計數請刪 .constellation/.verify-state.json 或修好後重跑）';
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
function runCommand(cmd, cwd, timeoutMs) {
  return new Promise(res => {
    const out = makeSink();
    const err = makeSink();
    let done = false, exited = false, endedStreams = 0, timedOut = false, exitCode = 1, spawnError = null;
    let timeoutTimer = null, graceTimer = null, hardStopTimer = null;

    const child = spawn(cmd, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], // stdin 直接關掉，指令不會卡在等輸入
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', LANG: 'C.UTF-8' },
    });
    currentChild = child;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      clearTimeout(hardStopTimer);
      // 放棄等待後主動關掉管線：孤兒若還在輸出，下次寫入會拿到 EPIPE，runner 也不會繼續替它
      // 收到 MAX_BUF 上限。
      try { child.stdout.destroy(); child.stderr.destroy(); } catch {}
      currentChild = null;
      res({ stdout: out.buffer(), stderr: err.buffer(), exitCode, timedOut, error: spawnError, shellPid: child.pid });
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      // taskkill 殺不動（提權子進程、taskkill 不在 PATH、防毒攔截）時 'exit' 永遠不來。
      // 排一道保險期限：到期自己 kill 一次外殼並無論如何結算，逾時路徑一定會回來。
      hardStopTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        finish();
      }, HARD_STOP_AFTER_KILL_MS);
    }, timeoutMs);

    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', c => err.push(c));
    const onStreamEnd = () => { endedStreams++; if (exited && endedStreams >= 2) finish(); };
    child.stdout.on('end', onStreamEnd);
    child.stderr.on('end', onStreamEnd);

    child.on('error', e => { spawnError = e; exitCode = 1; exited = true; finish(); });
    child.on('exit', code => {
      exited = true;
      // 進程已退出就停掉逾時計時器：後面還有最多 2 秒寬限窗口，計時器留著會誤報「逾時」
      // （誤導 debug 方向）並對已死的 pid 再打一次 taskkill。
      clearTimeout(timeoutTimer);
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
// 幾次 PowerShell 冷啟。而全機查完全不比只查幾個 pid 貴——本機實測兩種寫法都是 7–15 秒，成本全在
// 冷啟（單獨起 powershell 什麼都不做就要 2 秒）與 CIM 模組載入，不在掃描量（全機 440 進程約 170KB）。
function queryProcessTable() {
  const script =
    `$r=@(Get-CimInstance Win32_Process | ` +
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

async function main() {
  const { ticket, cwd: cwdArg, scope: scopeArg } = parseArgs(process.argv.slice(2));
  const scope = scopeArg || 'ticket';
  if (scope !== 'ticket' && scope !== 'ship') {
    console.error(`--scope 只能是 ticket 或 ship（收到："${scopeArg}"）`);
    process.exit(1);
  }
  const cwd = resolve(cwdArg || process.cwd());

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
  for (const cmd of commands) {
    const cmdStartMs = Date.now();
    const r = await runCommand(cmd, cwd, timeoutMs);
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
      if (timedOut) console.error(`逾時：超過 ${timeoutMs / 1000} 秒未結束，已強制終止該指令。`);
      if (r.error) console.error(`spawn 錯誤：${r.error.message}`);
      console.error('--- stdout ---');
      console.error(outDecoded.text);
      if (outDecoded.note) console.error(outDecoded.note);
      console.error('--- stderr ---');
      console.error(errDecoded.text);
      if (errDecoded.note) console.error(errDecoded.note);

      const failCount = recordFailure(cwd, target);
      if (failCount >= BREAKER_LIMIT) {
        console.error(`\nConstellation 驗證斷路器：${breakerTrippedMessage()}`);
        process.exit(2);
      }
      console.error('未寫入驗證證據，這張票不能標 done。');
      process.exit(1);
    }
    const realTailText = tail(outDecoded.text, 15);
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
    const repoRoot = repoRootToken(cwd);
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
    const existing = existsSync(shipEvidencePath)
      ? stripBom(readFileSync(shipEvidencePath, 'utf8'))
      : '# Constellation 出貨驗證證據\n\n> 由 `verify-runner.mjs --scope ship` 寫入，證據筆格式與票內完全相同（見 DESIGN.md §5）。\n';
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
