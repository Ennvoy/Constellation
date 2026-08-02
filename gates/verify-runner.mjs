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
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
const SCOPED_HEADING_RE = /^##\s*驗證指令.*$/m;
const SCOPED_CMD_RE = /^\s*-\s*`(.+)`\s*$/;

function parseScopedCommands(content) {
  const m = content.match(SCOPED_HEADING_RE);
  if (!m) return [];
  const after = m.index + m[0].length;
  const rest = content.slice(after);
  const next = rest.match(/\n##\s/);
  const section = next ? rest.slice(0, next.index) : rest;
  const cmds = [];
  for (const line of section.split(/\r?\n/)) {
    const cm = line.match(SCOPED_CMD_RE);
    if (cm) cmds.push(cm[1]);
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

function main() {
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
    const scoped = parseScopedCommands(stripBom(readFileSync(ticketPath, 'utf8')));
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

  const results = [];
  for (const cmd of commands) {
    const r = spawnSync(cmd, {
      cwd,
      shell: true,
      encoding: 'buffer',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', LANG: 'C.UTF-8' },
      maxBuffer: 20 * 1024 * 1024,
      timeout: timeoutMs,
    });
    const outDecoded = decodeOutput(r.stdout);
    const errDecoded = decodeOutput(r.stderr);
    const timedOut = r.error && r.error.code === 'ETIMEDOUT';
    const exitCode = r.error ? 1 : (r.status ?? 1);
    if (exitCode !== 0) {
      console.error(`驗證失敗：\`${cmd}\`（exit ${exitCode}）`);
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
    results.push({ cmd, realTailText, note: outDecoded.note, realLastLine: lastNonBlankLine(realTailText) });
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
    console.log(`驗證通過（${title}）：${results.length} 項指令全數 exit 0，證據已寫入 ${ticketPath}`);
  } else {
    const shipEvidencePath = join(cwd, '.constellation', 'ship-evidence.md');
    const existing = existsSync(shipEvidencePath)
      ? stripBom(readFileSync(shipEvidencePath, 'utf8'))
      : '# Constellation 出貨驗證證據\n\n> 由 `verify-runner.mjs --scope ship` 寫入，證據筆格式與票內完全相同（見 DESIGN.md §5）。\n';
    writeFileSync(shipEvidencePath, appendEvidence(existing, entryText), 'utf8');
    console.log(`出貨驗證通過：${results.length} 項指令（test＋journey 全量）全數 exit 0，證據已寫入 ${shipEvidencePath}`);
  }
  for (const r of results) console.log(`  - ${r.cmd}（exit 0）`);
  process.exit(0);
}

main();
