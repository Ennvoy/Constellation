#!/usr/bin/env node
// Constellation 閘門 4 —— 驗證 runner（CLI，非 hook）。DESIGN.md §4／§5。
// 用法：node verify-runner.mjs --ticket <tickets/T-xxx.md 路徑> [--cwd <專案根>]
// 讀 {cwd}/.constellation/config.json 的 commands.test（必要）＋ commands.journey（選填，
// DESIGN §5 閘門 4 明定「測試套件＋真鏈路 journey」皆屬本 runner 職責，phase-weave.md／
// phase-build.md 也是這樣描述 config 用法）——兩者合併、依序以 spawnSync 逐一實跑。
// 全部 exit 0 才在票的「## 驗證證據」section append 一筆（時間戳＋各指令＋exit code＋stdout 尾 15 行）；
// 任一失敗：印該指令完整輸出、不寫證據、exit 1——證據不能靠人手填，必須是這支 runner 親自跑出來的。
//
// R1 證據防偽：光「不能手填時間戳」不夠——時間戳本身也是純文字，手改票檔一樣能塞一個 24 小時內的
// ISO 字串。真正的防偽來自簽章：對「ISO 時間戳＋票檔相對路徑＋全部指令串接＋輸出尾行」算
// HMAC-SHA256（secret 只存在使用者家目錄、不進 git、不落 repo），證據筆尾附一行 `sig: <hex>`。
// 沒有這把 secret 就無法算出合法簽章，手填時間戳因此真的擋不過關票刷卡機（gates/close-gate.mjs）。
// **鏡像提醒**：本檔的簽章建構邏輯（SECRET_PATH／ticketRelPath／FIELD_SEP／computeSignature，
// 以及簽章涵蓋的欄位定義）與 gates/close-gate.mjs 的驗簽邏輯必須逐字元一致，兩檔各自內聯一份
// （不共用 import）——關票刷卡機是安全閘門，不依賴另一支腳本的存在／版本；改一份要同步改另一份。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join, basename } from 'node:path';
import { createHmac } from 'node:crypto';
import { homedir } from 'node:os';

const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// ---------------------------------------------------------------------------
// R1 簽章（與 close-gate.mjs 鏡像，見檔頭說明）
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

// 欄位分隔字元：一般文字與指令輸出裡幾乎不可能出現的控制字元（U+0001, SOH），
// 用來串接簽章的各欄位、避免欄位邊界混淆。兩邊腳本的值與位置必須逐字元一致。
const FIELD_SEP = '';

// 簽章涵蓋欄位：ISO 時間戳、票檔相對路徑、全部指令以 '\n' 串接、輸出尾行（最後一個指令的 tail
// 輸出裡最後一個非空白行；沒有輸出則為空字串）。
function computeSignature(secret, ts, relPath, commandsJoined, lastLine) {
  const payload = [ts, relPath, commandsJoined, lastLine].join(FIELD_SEP);
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function parseArgs(argv) {
  const out = { ticket: '', cwd: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ticket') out.ticket = argv[++i] || '';
    else if (argv[i] === '--cwd') out.cwd = argv[++i] || '';
  }
  return out;
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
  const { ticket, cwd: cwdArg } = parseArgs(process.argv.slice(2));
  if (!ticket) {
    console.error('用法：node verify-runner.mjs --ticket <tickets/T-xxx.md 路徑> [--cwd <專案根>]');
    process.exit(1);
  }
  const cwd = resolve(cwdArg || process.cwd());
  const ticketPath = resolve(cwd, ticket);
  if (!existsSync(ticketPath)) {
    console.error(`找不到票檔：${ticketPath}`);
    process.exit(1);
  }

  const configPath = join(cwd, '.constellation', 'config.json');
  let config = {};
  try { config = JSON.parse(stripBom(readFileSync(configPath, 'utf8'))); } catch {
    console.error(`讀不到或解析失敗：${configPath}（需要 commands.test／commands.journey 才知道要跑什麼指令）`);
    process.exit(1);
  }
  const commandsCfg = config.commands || {};
  const commands = [...toCommandList(commandsCfg.test), ...toCommandList(commandsCfg.journey)];
  if (!commands.length) {
    console.error(`${configPath} 的 commands.test／commands.journey 都是空的——沒有指令可驗證。補上指令，或這張票該標 blocked（見 phase-weave.md）。`);
    process.exit(1);
  }

  const results = [];
  for (const cmd of commands) {
    const r = spawnSync(cmd, {
      cwd,
      shell: true,
      encoding: 'buffer',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', LANG: 'C.UTF-8' },
      maxBuffer: 20 * 1024 * 1024,
    });
    const outDecoded = decodeOutput(r.stdout);
    const errDecoded = decodeOutput(r.stderr);
    const exitCode = r.error ? 1 : (r.status ?? 1);
    if (exitCode !== 0) {
      console.error(`驗證失敗：\`${cmd}\`（exit ${exitCode}）`);
      if (r.error) console.error(`spawn 錯誤：${r.error.message}`);
      console.error('--- stdout ---');
      console.error(outDecoded.text);
      if (outDecoded.note) console.error(outDecoded.note);
      console.error('--- stderr ---');
      console.error(errDecoded.text);
      if (errDecoded.note) console.error(errDecoded.note);
      console.error('未寫入驗證證據，這張票不能標 done。');
      process.exit(1);
    }
    const realTailText = tail(outDecoded.text, 15);
    // 註記獨立於 fenced block 之外（不混進去）：簽章的「輸出尾行」只認 block 內的真實內容，
    // 註記文字本身絕不能被誤當成輸出內容去參與簽章——兩者職責分開，關票刷卡機解析時才不會混淆。
    results.push({ cmd, realTailText, note: outDecoded.note, realLastLine: lastNonBlankLine(realTailText) });
  }

  // 全部通過 → 落證據（含簽章）
  const raw = stripBom(readFileSync(ticketPath, 'utf8'));
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
    const relPath = ticketRelPath(ticketPath);
    const commandsJoined = results.map(r => r.cmd).join('\n');
    const lastCmdResult = results[results.length - 1];
    // 簽章用的「輸出尾行」取真正解碼後內容的最後非空白行（不含保底解碼註記那一行），
    // 這樣才是對「實際輸出內容」的指紋，不是對註記文字的指紋。
    const lastLine = lastCmdResult ? lastCmdResult.realLastLine : '';
    const sig = computeSignature(secret, ts, relPath, commandsJoined, lastLine);
    entryLines.push(`  - sig: ${sig}`);
  } else {
    console.warn(`警告：讀不到簽章 secret 檔（${SECRET_PATH}）——這筆證據將標記為 unsigned，關票刷卡機會擋下。`);
    console.warn('先跑 install.ps1 產生 secret 後再重跑本 runner，才能產生可過關的簽章證據。');
    entryLines.push('  - sig: unsigned');
  }

  writeFileSync(ticketPath, appendEvidence(raw, entryLines.join('\n')), 'utf8');

  const title = ticketTitle(raw) || basename(ticketPath);
  console.log(`驗證通過（${title}）：${results.length} 項指令全數 exit 0，證據已寫入 ${ticketPath}`);
  for (const r of results) console.log(`  - ${r.cmd}（exit 0）`);
  process.exit(0);
}

main();
