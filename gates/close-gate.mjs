#!/usr/bin/env node
// Constellation 閘門 5 —— 關票刷卡機（PreToolUse hook，matcher Edit|Write|MultiEdit／Codex 端另含
// apply_patch）。DESIGN.md §4／§5。
// 只在「目標是 .constellation/tickets/*.md 且新內容把 status 設為 done」時檢查：
//   - Write（帶完整新內容 content）→ 直接檢查新內容本身。
//   - Edit（只帶變更片段 new_string）→ 讀磁碟現檔（編輯前）的「## 驗證證據」section。
//   - MultiEdit（tool_input.edits 陣列）→ 任一 edit 的 new_string 把 status 設 done，就讀磁碟現檔驗證。
//   - apply_patch（Codex 原生編輯工具）→ 解析 `*** Update File: <路徑>` 找出受影響票檔，patch 內容
//     含新增的 `+status: done` 才驗證，讀磁碟現檔（patch 套用前）確認證據。patch 文字本身用 fallback
//     鏈依序嘗試 tool_input.patch → tool_input.command → input.patch → input.command——Codex 官方
//     payload 實際把 apply_patch 內容放在 command 欄位（不是 patch 欄位），只認 tool_input.patch
//     會讀錯欄位、形同虛設，這是本檔這輪修復裡最重要的一項。
// 沒有「24 小時內＋簽章核對通過」的證據、或「## 驗收條件」尚有未勾項 → stderr 印理由、exit 2 擋下；
// 都過 → 放行。任何解析異常一律 fail-open（放行），不誤擋日常編輯——擋人是例外，不是預設。
//
// R1 證據防偽：只認「24 小時內的 ISO 時間戳」不夠防偽——時間戳是純文字，手改票檔一樣能塞一個
// 24 小時內的字串進去。真正把關的是簽章：對最新一筆證據的「ISO 時間戳＋票檔相對路徑＋全部指令
// 串接＋輸出尾行＋repo 根絕對路徑」重算 HMAC-SHA256，核對證據筆尾的 `sig: <hex>` 行——簽章缺失／
// 不符／unsigned／secret 檔不存在，一律擋下（secret 不存在時 fail-closed：沒有 secret 就無法驗證
// 任何東西，一律當作未過關，不能因為讀不到 secret 就放水）。repo 根這段防跨專案重放。
// **鏡像提醒**：本檔的簽章建構邏輯（SECRET_PATH／ticketRelPath／FIELD_SEP／computeSignature／
// repoRootToken，以及簽章涵蓋的欄位定義）與 gates/verify-runner.mjs 的簽章邏輯、gates/commit-gate.mjs
// 的 done 票稽核驗簽邏輯必須逐字元一致，三檔各自內聯一份（不共用 import）——這是安全閘門，不依賴
// 另一支腳本的存在／版本；改一份要同步改另兩份。
import { readFileSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

const PASS = { block: false };
const BLOCK = msg => ({ block: true, message: msg });

// 票檔路徑判定：`(^|[\\/])` 讓「絕對路徑（前面一定有分隔符）」與「patch 裡給的相對路徑
// （可能直接以 .constellation 開頭、沒有前導分隔符）」都能匹配同一條規則。
const TICKET_PATH_RE = /(^|[\\/])\.constellation[\\/]tickets[\\/][^\\/]+\.md$/i;
const STATUS_DONE_RE = /^\s*status\s*:\s*done\s*(?:#.*)?$/im;
// apply_patch 的新增行以 `+` 開頭（unified diff 慣例），只有「新增」status: done 才算這次操作把票關掉。
const STATUS_DONE_ADDED_RE = /^\+\s*status\s*:\s*done\s*(?:#.*)?\s*$/m;
// 只認「驗證證據」開頭即可，不要求整行只有這四個字——實際模板標題帶括號說明文字
// （如「## 驗證證據（關票時由 runner 寫入...）」），要求整行精確符合會漏配該 section。
const EVIDENCE_HEADING_RE = /^##\s*驗證證據.*$/m;
// 「## 驗收條件」section 內、行首未勾選的列項（- [ ]，允許前導縮排——巢狀清單也算數）。
const ACCEPTANCE_HEADING_RE = /^##\s*驗收條件.*$/m;
const UNCHECKED_ACCEPTANCE_RE = /^\s*-\s*\[\s\]/m;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000; // 容許 5 分鐘時鐘飄移，別把剛寫入的證據當成「未來時間」而判失敗

// R6：驗證 runner 的絕對路徑，攔截訊息裡建議的呼叫指令一律用絕對路徑（不靠使用者猜相對路徑、
// 不受 hook 執行時 cwd 影響）。
const GATES_DIR = dirname(fileURLToPath(import.meta.url));
const VERIFY_RUNNER_ABS_PATH = join(GATES_DIR, 'verify-runner.mjs');

// ---------------------------------------------------------------------------
// R1 簽章（與 verify-runner.mjs／commit-gate.mjs 鏡像，見檔頭說明）
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

function ticketRelPath(p) {
  const norm = String(p).replace(/\\/g, '/');
  const m = norm.match(/\.constellation\/tickets\/[^/]+\.md$/i);
  return m ? m[0] : norm;
}

// repo 根識別 token：path.resolve 正規化後轉小寫、反斜線轉正斜線。
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

// 從 hook payload 解析 cwd（多鍵名 fallback）——與 verify-runner 的 --cwd 概念上是同一個「專案根」，
// 必須用同一套推導方式（resolve→小寫→正斜線）才能讓兩邊算出的 repoRootToken 一致。
function resolveCwd(input) {
  return input.cwd ?? input.workspace_root ?? input.workingDirectory ?? process.cwd();
}

// ---------------------------------------------------------------------------
// 驗收條件解析：取「## 驗收條件」section，判斷是否還有未勾選列項。
// ---------------------------------------------------------------------------
function acceptanceSection(content) {
  const m = content.match(ACCEPTANCE_HEADING_RE);
  if (!m) return '';
  const after = m.index + m[0].length;
  const rest = content.slice(after);
  const next = rest.match(/\n##\s/);
  return next ? rest.slice(0, next.index) : rest;
}

function hasUncheckedAcceptance(content) {
  const section = acceptanceSection(content);
  if (!section) return false; // 沒有這個 section 就不擋——不強迫每張票都用這個模板
  return UNCHECKED_ACCEPTANCE_RE.test(section);
}

// ---------------------------------------------------------------------------
// 證據 section／證據筆解析
// ---------------------------------------------------------------------------
function evidenceSection(content) {
  const m = content.match(EVIDENCE_HEADING_RE);
  if (!m) return '';
  const after = m.index + m[0].length;
  const rest = content.slice(after);
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

// 找「最後一個指令」之後的輸出尾行：可能先有一行保底解碼註記（4 空白縮排、整行括號包住），
// 跳過它，再看是否緊接 fenced block（4 空白縮排的 ``` 開合），取 block 內最後一個非空白行
// （去掉 4 空白縮排，還原成 verify-runner 當初寫入的原始字串）——沒有 block 就是空字串。
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

// ---------------------------------------------------------------------------
// 訊息
// ---------------------------------------------------------------------------
function runnerHint() {
  return `先跑 node "${VERIFY_RUNNER_ABS_PATH}" --ticket <這張票路徑> [--cwd <專案根>]，讓驗證真的跑一次、把簽章證據落進票裡，再標 done。`;
}

function missingSecretMessage(filePath) {
  return [
    `Constellation 關票刷卡機：擋下——${filePath} 要把 status 設為 done，但讀不到簽章 secret 檔（${SECRET_PATH}）。`,
    '  → 沒有 secret 就無法驗證任何簽章，一律視為未過關（fail-closed）；請先跑 install.ps1 產生 secret，再重跑 verify-runner 補一筆簽章證據。',
  ].join('\n');
}

function noEvidenceMessage(filePath) {
  return [
    `Constellation 關票刷卡機：擋下——${filePath} 要把 status 設為 done，但「## 驗證證據」section 沒有可辨識的證據筆。`,
    `  → ${runnerHint()}`,
    '  驗證證據只能由 verify-runner 寫入，不能手填繞過（DESIGN.md §4／§5）。',
  ].join('\n');
}

function staleMessage(filePath) {
  return [
    `Constellation 關票刷卡機：擋下——${filePath} 要把 status 設為 done，但最新一筆驗證證據已超過 24 小時新鮮期。`,
    `  → ${runnerHint()}`,
  ].join('\n');
}

function missingSigMessage(filePath) {
  return [
    `Constellation 關票刷卡機：擋下——${filePath} 最新一筆驗證證據缺少 sig 簽章行，無法確認是 verify-runner 親自跑出來的。`,
    `  → ${runnerHint()}`,
  ].join('\n');
}

function unsignedMessage(filePath) {
  return [
    `Constellation 關票刷卡機：擋下——${filePath} 最新一筆驗證證據標記為 unsigned（產生時讀不到簽章 secret）。`,
    '  → 請先跑 install.ps1 產生 secret，再重跑 verify-runner，讓證據帶上有效簽章。',
  ].join('\n');
}

function mismatchMessage(filePath) {
  return [
    `Constellation 關票刷卡機：擋下——${filePath} 最新一筆驗證證據的簽章核對不符，可能被手動竄改或並非 verify-runner 產生。`,
    `  → ${runnerHint()}`,
  ].join('\n');
}

function uncheckedAcceptanceMessage(filePath) {
  return [
    `Constellation 關票刷卡機：擋下——${filePath} 要把 status 設為 done，但「## 驗收條件」尚有未勾項。`,
    '  → 驗收條件尚有未勾項——逐條實跑驗過、勾滿再關票',
  ].join('\n');
}

// 核心驗證：給定完整票檔內容、檔案路徑、cwd（用於 repo 根 token），判斷驗收條件是否全勾、
// 最新一筆證據是否新鮮且簽章核對通過。
function verifyEvidence(content, filePath, cwd) {
  if (hasUncheckedAcceptance(content)) return BLOCK(uncheckedAcceptanceMessage(filePath));

  const secret = readSecret();
  if (!secret) return BLOCK(missingSecretMessage(filePath));

  const section = evidenceSection(content);
  const entry = section ? latestEntry(section) : null;
  if (!entry) return BLOCK(noEvidenceMessage(filePath));

  const now = Date.now();
  const t = Date.parse(entry.ts);
  const fresh = !Number.isNaN(t) && (now - t <= ONE_DAY_MS) && (now - t >= -CLOCK_SKEW_MS);
  if (!fresh) return BLOCK(staleMessage(filePath));

  if (!entry.sig) return BLOCK(missingSigMessage(filePath));
  if (entry.sig === 'unsigned') return BLOCK(unsignedMessage(filePath));

  const relPath = ticketRelPath(filePath);
  const repoRoot = repoRootToken(cwd);
  const expected = computeSignature(secret, entry.ts, relPath, entry.commandsJoined, entry.lastLine, repoRoot);
  if (!safeHexEqual(expected, entry.sig)) return BLOCK(mismatchMessage(filePath));

  return PASS;
}

// Edit／MultiEdit／apply_patch 共用：從磁碟讀「編輯前」的現檔內容來驗證（變更片段裡通常沒有
// 證據 section，證據活在檔案其他地方）。讀不到檔案就放行，不誤擋（fail-open）。
function verifyFromDisk(filePath, cwd) {
  let disk;
  try { disk = readFileSync(filePath, 'utf8'); } catch { return PASS; }
  return verifyEvidence(stripBom(disk), filePath, cwd);
}

// ---------------------------------------------------------------------------
// apply_patch（Codex 原生編輯工具）：patch 文字裡用 `*** Update File: <路徑>` 標出受影響檔案，
// 一份 patch 可能同時動多個檔案，逐一切段檢查。
// ---------------------------------------------------------------------------
const PATCH_FILE_MARKER_RE = /^\*\*\* (Update File|Add File|Delete File): (.+)$/;

function checkApplyPatch(patchText, input) {
  const lines = patchText.split(/\r?\n/);
  const markers = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PATCH_FILE_MARKER_RE);
    if (m) markers.push({ idx: i, kind: m[1], path: m[2].trim() });
  }
  if (!markers.length) return PASS;

  const cwd = resolveCwd(input);

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    if (marker.kind !== 'Update File') continue; // 新增/刪除檔案不會有「既有磁碟證據」可驗證
    if (!TICKET_PATH_RE.test(marker.path)) continue;

    const end = i + 1 < markers.length ? markers[i + 1].idx : lines.length;
    const segment = lines.slice(marker.idx, end).join('\n');
    if (!STATUS_DONE_ADDED_RE.test(segment)) continue;

    const absPath = resolve(cwd, marker.path);
    const r = verifyFromDisk(absPath, cwd);
    if (r.block) return r;
  }
  return PASS;
}

// 從一組候選值裡取第一個非空字串——apply_patch 的 patch 文字來源 fallback 鏈用。
function firstNonEmptyString(...vals) {
  for (const v of vals) if (typeof v === 'string' && v.length) return v;
  return '';
}

// ---------------------------------------------------------------------------
// 純判定（不碰 stdin/exit），方便日後測試或整合呼叫。回 { block, message? }。
// ---------------------------------------------------------------------------
export function closeGateCheck(input) {
  const tool = input.tool_name ?? input.toolName ?? '';
  const ti = input.tool_input ?? input.toolInput ?? {};

  if (tool === 'Write') {
    const filePath = String(ti.file_path ?? ti.filePath ?? '');
    if (!filePath || !TICKET_PATH_RE.test(filePath)) return PASS;
    const content = ti.content;
    if (typeof content !== 'string' || !STATUS_DONE_RE.test(content)) return PASS;
    return verifyEvidence(content, filePath, resolveCwd(input));
  }

  if (tool === 'Edit') {
    const filePath = String(ti.file_path ?? ti.filePath ?? '');
    if (!filePath || !TICKET_PATH_RE.test(filePath)) return PASS;
    const newString = ti.new_string ?? ti.newString;
    if (typeof newString !== 'string' || !STATUS_DONE_RE.test(newString)) return PASS;
    return verifyFromDisk(filePath, resolveCwd(input));
  }

  if (tool === 'MultiEdit') {
    const filePath = String(ti.file_path ?? ti.filePath ?? '');
    if (!filePath || !TICKET_PATH_RE.test(filePath)) return PASS;
    const edits = Array.isArray(ti.edits) ? ti.edits : [];
    const setsDone = edits.some(e => {
      const ns = e && (e.new_string ?? e.newString);
      return typeof ns === 'string' && STATUS_DONE_RE.test(ns);
    });
    if (!setsDone) return PASS;
    return verifyFromDisk(filePath, resolveCwd(input));
  }

  // Codex apply_patch：不嚴格卡 tool_name（Codex 端的實際 tool_name 可能是 apply_patch 或其他
  // 殼名），只要輸入形狀帶 patch 文字就進這條分支——matcher 層（hooks.codex.json）已經只放行
  // Edit|Write|apply_patch 三種工具進來，這裡再檢查形狀是雙重保險。
  // patch 文字來源 fallback 鏈：tool_input.patch → tool_input.command → input.patch → input.command
  // ——Codex 官方 payload 實際把 apply_patch 內容放在 command 欄位，只認 tool_input.patch 讀錯欄位、
  // 形同虛設，這是本檔這輪最重要的修復。
  const patchText = firstNonEmptyString(ti.patch, ti.command, input.patch, input.command);
  if (patchText) return checkApplyPatch(patchText, input);

  return PASS;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => process.exit(0));
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(stripBom(raw).trim() || '{}'); } catch { return process.exit(0); }
  let r;
  try { r = closeGateCheck(input); } catch { r = null; } // fail-open
  if (r && r.block) { process.stderr.write(String(r.message || '') + '\n'); process.exit(2); }
  process.exit(0);
});
