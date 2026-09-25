// gates/evidence.cjs — Constellation 簽章與證據解析的唯一實作（P14：三份鏡像合一）。
// 為什麼是 .cjs：close-gate.mjs／commit-gate.mjs 只在「碰到 done 票」這條路徑才需要這支模組，用
// createRequire 同步載入才能把「載入＋呼叫」包進同一個 try/catch、任何一步失敗就整段 fail-closed
// （擋下）——ESM 的 import() 是非同步，會讓呼叫端的判定函式一路變成 Promise，任何呼叫端漏加 await
// 就會靜默放行（P14 對抗審查否決 `await import()` 的理由）。CommonJS 的 require() 是同步的，
// try/catch 才接得住「模組不存在／語法壞掉／執行時丟例外／少了某個匯出」這幾種壞法。
//
// 誰用這支模組：
//   - gates/close-gate.mjs／gates/commit-gate.mjs（PreToolUse／git 原生 pre-commit 兩道關票稽核）：
//     用 createRequire(import.meta.url)('./evidence.cjs') 延遲同步載入，只在目標是
//     .constellation/tickets/*.md 且要把 status 設為 done 時才載入——載入或執行任何一步失敗，
//     呼叫端一律擋下（關票暫停／擋 commit），訊息講明是模組故障、不是繞過刷卡機。
//   - gates/verify-runner.mjs（CLI，不是 hook）：靜態 import——runner 本身就是簽證據的來源，模組壞
//     了就讓 runner 直接跑不出來（fail-closed）。這是 P14 新增的代價，不是既有行為：重構前讀不到
//     secret 時 runner 照跑、把證據寫成 sig: unsigned；現在模組整支壞掉時，runner 所有模式（含
//     --scope ship 全量與機器鎖排隊）都會直接跑不出來。換來的是「模組真的壞掉」這件事會立刻大聲
//     擋下，而不是悄悄退化——代價可接受，但要照實記，不能說成本來就是這樣。
//
// ⚠ 簽章內容不得更動：computeSignature 涵蓋的欄位（ISO 時間戳／票檔相對路徑或 "ship"／全部指令
// 串接／輸出尾行／repo 根絕對路徑）與串接順序、FIELD_SEP，一旦改了，舊票裡已經簽好的證據會全部
// 驗簽失敗。真要改欄位定義，得先想清楚舊證據的遷移路徑，不是這支模組自己能決定的事。
//
// 本模組只管「怎麼驗簽章」，不管「repo 根怎麼找」——close-gate 用票檔絕對路徑切根
// （ticketRootFromPath）、commit-gate 用 `git rev-parse --show-toplevel`，兩套推導方式差異夠大、
// 也各自被其他檢查依賴，留在各自檔案裡；checkLatestEvidence 只接受呼叫端已經解析好的 rootDir。
//
// ⚠ 兩項代價（合一之後才有，DESIGN.md §11.5 同步揭露）：
//   1. 這支模組的邏輯寫錯時，close-gate 與 commit-gate 兩層會同時失守——兩層原本各自一份鏡像時，
//      改壞一份還有另一層擋著；現在唯一獨立於本模組之外的保護只剩
//      gates/test/close-gate.test.mjs 裡那個獨立的 sign() 對照組。
//   2. 本模組整支壞掉（缺檔／語法錯／執行例外／少了匯出）時，全機所有採用 Constellation 工作流的
//      專案都關不了票、verify-runner.mjs 也跑不出證據——影響範圍限縮在「驗簽」這一件事，其他防線
//      （secrets／驗證垃圾／殺行程守門等）不受影響。
'use strict';

const { readFileSync } = require('node:fs');
const { createHmac, timingSafeEqual } = require('node:crypto');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');

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
// 不依賴呼叫時的 cwd——兩邊腳本各自從自己拿到的路徑字串獨立算出來，仍會得到同一個結果，這是簽章
// 能跨檔驗證的關鍵前提。
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
// 用來串接簽章的各欄位、避免欄位邊界混淆。
const FIELD_SEP = '\u0001';

// 簽章涵蓋欄位：ISO 時間戳、票檔相對路徑（或 "ship"）、全部指令以 '\n' 串接、輸出尾行（最後一個
// 指令的 tail 輸出裡最後一個非空白行；沒有輸出則為空字串）、repo 根絕對路徑 token。
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

// 只認「驗證證據」開頭即可，不要求整行只有這四個字——實際模板標題帶括號說明文字
// （如「## 驗證證據（關票時由 runner 寫入...）」），要求整行精確符合會漏配該 section。
const EVIDENCE_HEADING_RE = /^##\s*驗證證據.*$/m;

// 通用 section 擷取：取標題後到下一個 `## ` 之前的內容（沒有下一個標題就取到檔尾）。這裡只用來切
// 「## 驗證證據」——「## 驗收條件」「## 決議記錄」兩個 section 與簽章無關，仍各由 close-gate.mjs
// 自己的 sectionOf 處理，不屬於這支模組的職責（兩邊各留一份，見該檔檔頭說明）。
function sectionOf(content, headingRe) {
  const text = String(content ?? '');
  const m = text.match(headingRe);
  if (!m) return '';
  const after = m.index + m[0].length;
  const rest = text.slice(after);
  const next = rest.match(/\n##\s/);
  return next ? rest.slice(0, next.index) : rest;
}

// 每筆證據以「- **<ISO 時間戳>**」這種頂層（不縮排）列項起頭，切到下一筆同格式列項或 section 尾端。
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

// 找「最後一個指令」之後的輸出尾行：可能先有一行保底解碼註記（4 空白縮排、整行括號包住），跳過它，
// 再看是否緊接 fenced block（4 空白縮排的 ``` 開合），取 block 內最後一個非空白行（去掉 4 空白
// 縮排，還原成 verify-runner 當初寫入的原始字串）——沒有 block 就是空字串。
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
      const raw = block[k].startsWith('    ') ? block[k].slice(4) : block[k];
      if (raw.trim() !== '') return raw;
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

// 最新鮮證據筆：section 內所有證據筆依 ts 取最大值那一筆（不是「隨便找到一個近期時間戳」，
// 也不是「檔案裡位置最後一筆」——攻擊者插入的假筆若 ts 不是最大，不影響判定；若 ts 是最大，
// 一樣要通過簽章核對才放行）。
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

const CLOCK_SKEW_MS = 5 * 60 * 1000; // 容許 5 分鐘時鐘飄移，別把剛寫入的證據當成「未來時間」而判失敗

// ---------------------------------------------------------------------------
// checkLatestEvidence：關票／commit 稽核共用的驗簽入口。
// content：票檔完整內容（或 staged 版本內容）。ticketPath：票檔路徑（用來切出簽章涵蓋的相對路徑，
// 呼叫端已先過 TICKET_PATH_RE，這裡不重複判斷）。rootDir：呼叫端已經解析好的 repo 根（close-gate
// 用 ticketRootFromPath(filePath) ?? cwd；commit-gate 用 resolveRepoRoot(cwd) 的結果）——本模組
// 不負責「怎麼找 repo 根」，只負責拿到根之後怎麼驗簽章，各呼叫端的根推導方式不同、各自留在原檔。
// maxAgeMs：新鮮度窗口（close-gate 24 小時、commit-gate 7 天），由呼叫端決定。
//
// 回傳：通過回字串 'ok'；不通過回失敗代碼（呼叫端一律用 `=== 'ok'` 判斷放行，其他任何值——含
// 未來新增卻忘了處理的代碼——都當作擋下）：
//   'no-secret' 讀不到簽章 secret（fail-closed：沒有 secret 就無法驗證任何東西）。
//   'no-entry'  「## 驗證證據」section 沒有可辨識的證據筆。
//   'stale'     最新一筆證據已超過新鮮期。
//   'no-sig'    最新一筆證據缺少 sig 行。
//   'unsigned'  sig 標記為 unsigned（產生時讀不到 secret）。
//   'mismatch'  簽章核對不符（可能被竄改，或並非 verify-runner 產生）。
// ---------------------------------------------------------------------------
function checkLatestEvidence(content, ticketPath, rootDir, maxAgeMs) {
  const secret = readSecret();
  if (!secret) return 'no-secret';

  const section = sectionOf(String(content ?? ''), EVIDENCE_HEADING_RE);
  const entry = section ? latestEntry(section) : null;
  if (!entry) return 'no-entry';

  const now = Date.now();
  const t = Date.parse(entry.ts);
  const fresh = !Number.isNaN(t) && (now - t <= maxAgeMs) && (now - t >= -CLOCK_SKEW_MS);
  if (!fresh) return 'stale';

  if (!entry.sig) return 'no-sig';
  if (entry.sig === 'unsigned') return 'unsigned';

  const relPath = ticketRelPath(ticketPath);
  const repoRoot = repoRootToken(rootDir);
  const expected = computeSignature(secret, entry.ts, relPath, entry.commandsJoined, entry.lastLine, repoRoot);
  if (!safeHexEqual(expected, entry.sig)) return 'mismatch';

  return 'ok';
}

// ⚠ verify-runner.mjs 對本模組是具名匯入（import { SECRET_PATH, ... } from './evidence.cjs'），靠
// Node 從下面這種「值就是同名變數」的簡寫靜態推出匯出名稱——插入「值不是同名變數」的項目（例如
// `X: 5*60*1000`）會讓它後面的名稱推不出來，runner 啟動時直接 SyntaxError。新增匯出請維持簡寫，
// 或放在最後面。
module.exports = {
  SECRET_PATH,
  readSecret,
  ticketRelPath,
  repoRootToken,
  computeSignature,
  COMMAND_LINE_RE,
  checkLatestEvidence,
};
