#!/usr/bin/env node
// Constellation 閘門 5 —— 關票刷卡機（PreToolUse hook，matcher Edit|Write／Codex 端另含
// apply_patch）。DESIGN.md §4／§5。
// 只在「目標是 .constellation/tickets/*.md 且新內容把 status 設為 done」時檢查：
//   - Write（帶完整新內容 content）→ 直接檢查新內容本身。
//   - Edit（只帶變更片段 new_string）→ 讀磁碟現檔（編輯前）的「## 驗證證據」section。
//   - apply_patch（Codex 原生編輯工具）→ 解析 `*** Update File: <路徑>` 找出受影響票檔，patch 內容
//     含新增的 `+status: done` 才驗證，讀磁碟現檔（patch 套用前）確認證據。patch 文字讀
//     tool_input.command——Codex 官方 payload 把 apply_patch 內容放在這個欄位，不是 patch 欄位。
// 沒有「24 小時內＋簽章核對通過」的證據、或「## 驗收條件」尚有未勾項 → stderr 印理由、exit 2 擋下；
// 都過 → 放行。任何解析異常一律 fail-open（放行），不誤擋日常編輯——擋人是例外，不是預設。
//
// R1 證據防偽：只認「24 小時內的 ISO 時間戳」不夠防偽——時間戳是純文字，手改票檔一樣能塞一個
// 24 小時內的字串進去。真正把關的是簽章：對最新一筆證據的「ISO 時間戳＋票檔相對路徑＋全部指令
// 串接＋輸出尾行＋repo 根絕對路徑」重算 HMAC-SHA256，核對證據筆尾的 `sig: <hex>` 行——簽章缺失／
// 不符／unsigned／secret 檔不存在，一律擋下（secret 不存在時 fail-closed：沒有 secret 就無法驗證
// 任何東西，一律當作未過關，不能因為讀不到 secret 就放水）。repo 根這段防跨專案重放；票檔的 repo 根
// 一律從票檔自己的絕對路徑切出來（見 ticketRootFromPath），不依賴 hook 傳進來的 cwd——hook 的 cwd
// 可能是子目錄或另一個 worktree，跟簽出證據當下的 repo 根對不上，會把合法證據誤判成竄改（見 P3／
// findProjectRoot：其餘讀 .constellation 底下設定檔的地方，root 一律從目標檔所在目錄往上找）。
// 簽章與解析的唯一實作在 gates/evidence.cjs（P14：三份鏡像合一）：本檔只在「碰到 done 票」（目標是
// 票檔且要把 status 設為 done）時才用 createRequire 同步載入該模組並呼叫 checkLatestEvidence——
// 載入或執行任一步失敗（缺檔／語法壞掉／丟例外／少了匯出／回傳未知代碼）一律 fail-closed 擋下，
// 訊息講明是模組故障、不是繞過刷卡機（見 verifyEvidence／evidenceModuleFailureMessage）。
//
// 下輪待辦抽屜守衛（DESIGN.md §5，決議 027）：Write／Edit／apply_patch 把 `.constellation/next-round/`
// 裡的票標成 `status: done` 一律擋下——那些票還沒經 weave 收編進 `tickets/`，不驗、不關；要做先經
// weave 搬進 `tickets/`，不需要做了則搬進 `archive/next-round-closed/`（見 checkNextRoundGuard／
// nextRoundMessage）。此檢查與上面的 done 票檢查、下面的定稿凍結守衛各自獨立觸發。
//
// 定稿 UI 凍結守衛（DESIGN.md §3 第 4 點／§5）：另外讀取 `.constellation/design-frozen.json`
// 的 frozen 陣列，命中名單的目標檔案一律擋下編輯（Write／Edit／apply_patch 皆涵蓋，不限
// 票檔）——要改必須先經使用者彈窗同意、把該檔從 frozen 移除並在 log 記一筆 unfreeze（含原因）。名單
// 檔不存在或解析失敗一律 fail-open，不影響非 UI 專案；目標本身就是 design-frozen.json 時不受此檢查
// 限制（否則永遠無法解凍）。此檢查與上面的 done 票檢查各自獨立觸發，互不影響、互不依賴。
// 判定實作在 gates/frozen-guard.mjs（決議 030 抽出）；Bash／PowerShell 寫檔由 pre-tool-use.mjs 呼叫同一份。
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  findProjectRoot, normalizeRepoRelPath, checkFrozenPath, DESIGN_FROZEN_REL, DESIGN_FROZEN_PATH_RE,
} from './frozen-guard.mjs';

const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

const PASS = { block: false };
const BLOCK = msg => ({ block: true, message: msg });

// 票檔路徑判定：`(^|[\\/])` 讓「絕對路徑（前面一定有分隔符）」與「patch 裡給的相對路徑
// （可能直接以 .constellation 開頭、沒有前導分隔符）」都能匹配同一條規則。
const TICKET_PATH_RE = /(^|[\\/])\.constellation[\\/]tickets[\\/][^\\/]+\.md$/i;
const STATUS_DONE_RE = /^\s*status\s*:\s*done\s*(?:#.*)?$/im;
// apply_patch 的新增行以 `+` 開頭（unified diff 慣例），只有「新增」status: done 才算這次操作把票關掉。
const STATUS_DONE_ADDED_RE = /^\+\s*status\s*:\s*done\s*(?:#.*)?\s*$/m;
// 「下輪待辦」抽屜（附帶）：出貨時開給下一輪的候選票暫存區，不算這一輪的 tickets/，不驗、不關——
// 要做就先經 weave 原樣搬進 tickets/ 再走正常流程。這裡只擋「把抽屜裡的票直接標成 done」這個動作。
const NEXT_ROUND_PATH_RE = /(^|[\\/])\.constellation[\\/]next-round[\\/][^\\/]+\.md$/i;
// 「## 驗收條件」section 內、行首未勾選的列項（- [ ]，允許前導縮排——巢狀清單也算數）。
const ACCEPTANCE_HEADING_RE = /^##\s*驗收條件.*$/m;
const UNCHECKED_ACCEPTANCE_RE = /^\s*-\s*\[\s\]/m;
// 關票當下的證據新鮮期（傳給 evidence.cjs 的 checkLatestEvidence 當 maxAgeMs；commit-gate 稽核放寬
// 到 7 天，見該檔）。
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// R6：驗證 runner 的絕對路徑，攔截訊息裡建議的呼叫指令一律用絕對路徑（不靠使用者猜相對路徑、
// 不受 hook 執行時 cwd 影響）。
const GATES_DIR = dirname(fileURLToPath(import.meta.url));
const VERIFY_RUNNER_ABS_PATH = join(GATES_DIR, 'verify-runner.mjs');

// 票檔的絕對路徑必定含 `/.constellation/tickets/<檔名>`，切掉這段之後即為 repo 根——純字串運算，
// 不查檔案系統，才能與 verify-runner.mjs 各自從同一個票檔路徑切出同一個根（見 P3、檔頭說明）。
// 不是票檔路徑（呼叫端理論上已先過 TICKET_PATH_RE）就回 null，呼叫端退回舊的 cwd 判斷。
function ticketRootFromPath(absTicketPath) {
  const norm = String(absTicketPath).replace(/\\/g, '/');
  const m = norm.match(/^(.*)\/\.constellation\/tickets\/[^/]+\.md$/i);
  return m ? m[1] : null;
}

// 從 hook payload 解析 cwd（多鍵名 fallback）——與 verify-runner 的 --cwd 概念上是同一個「專案根」，
// 必須用同一套推導方式（resolve→小寫→正斜線）才能讓兩邊算出的 repoRootToken 一致。
function resolveCwd(input) {
  return input.cwd ?? input.workspace_root ?? input.workingDirectory ?? process.cwd();
}

// ---------------------------------------------------------------------------
// 通用 section 擷取：給定 content 與該 section 的標題正則，取標題後到下一個 `## ` 之前的內容
// （沒有下一個標題就取到檔尾）。三個 section（驗收條件／驗證證據／決議記錄）都靠它，只差標題正則。
// ---------------------------------------------------------------------------
function sectionOf(content, headingRe) {
  const text = String(content ?? '');
  const m = text.match(headingRe);
  if (!m) return '';
  const after = m.index + m[0].length;
  const rest = text.slice(after);
  const next = rest.match(/\n##\s/);
  return next ? rest.slice(0, next.index) : rest;
}

function hasUncheckedAcceptance(content) {
  const section = sectionOf(content, ACCEPTANCE_HEADING_RE);
  if (!section) return false; // 沒有這個 section 就不擋——不強迫每張票都用這個模板
  return UNCHECKED_ACCEPTANCE_RE.test(section);
}

// ---------------------------------------------------------------------------
// 訊息
// ---------------------------------------------------------------------------
function runnerHint() {
  return `先跑 node "${VERIFY_RUNNER_ABS_PATH}" --ticket <這張票路徑> [--cwd <專案根>]，讓驗證真的跑一次、把簽章證據落進票裡，再標 done。`;
}

function missingSecretMessage(filePath, secretPath) {
  return [
    `Constellation 關票刷卡機：擋下——${filePath} 要把 status 設為 done，但讀不到簽章 secret 檔（${secretPath}）。`,
    '  → 沒有 secret 就無法驗證任何簽章，一律視為未過關（fail-closed）；請先跑 install.ps1 產生 secret，再重跑 verify-runner 補一筆簽章證據。',
  ].join('\n');
}

// evidence.cjs 載入失敗（缺檔／語法壞掉）或執行失敗（丟例外／少了匯出／回傳未知代碼）一律歸類這條——
// 是模組本身故障，不是這張票的證據有問題，訊息刻意不講「可能被竄改」，避免誤導成使用者的問題。
function evidenceModuleFailureMessage(filePath) {
  return [
    `Constellation 關票刷卡機：擋下——${filePath} 要把 status 設為 done，但簽章模組 evidence.cjs 載入或執行失敗，關票暫停。`,
    '  → 這是模組本身的故障（缺檔／語法錯／執行例外），不是這張票的證據有問題；確認 gates/evidence.cjs 存在且正常後再重試關票。',
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

function nextRoundMessage(filePath) {
  return [
    `Constellation 關票刷卡機：擋下——${filePath} 在「下輪待辦」抽屜（.constellation/next-round/）裡。`,
    '  → 下輪待辦抽屜裡的票不驗、不關；要做先經 weave 搬進 tickets/。',
    '  → 不需要做了（放棄，或已被本輪別的改動順手解決）：git mv 到 .constellation/archive/next-round-closed/，並在決議記錄寫下原因——不要就地改成 status: done。',
  ].join('\n');
}

// 下輪待辦抽屜守衛：只擋 Write／Edit 把抽屜裡的票直接標成 done 這個動作，其他編輯（改標題、補描述）
// 不受影響。apply_patch 的抽屜檢查併入 checkApplyPatch 自己的 marker 迴圈（見該函式），不在此重複。
function checkNextRoundGuard(tool, ti) {
  if (tool !== 'Write' && tool !== 'Edit') return null;
  const filePath = String(ti.file_path ?? '');
  if (!filePath || !NEXT_ROUND_PATH_RE.test(filePath)) return null;
  const text = tool === 'Write' ? ti.content : (ti.new_string ?? ti.newString);
  if (typeof text !== 'string' || !STATUS_DONE_RE.test(text)) return null;
  return BLOCK(nextRoundMessage(filePath));
}

// evidence.cjs 只在真的碰到「目標是票檔且要把 status 設為 done」時才載入（見上方呼叫端），
// 用 createRequire 同步載入——ESM 的 import() 是非同步，會讓判定函式變成 Promise，呼叫端漏加
// await 就會靜默放行（P14 對抗審查否決的做法）。
const loadEvidence = () => createRequire(import.meta.url)('./evidence.cjs');

// 核心驗證：給定完整票檔內容、檔案路徑、cwd（用於 repo 根推導），判斷驗收條件是否全勾、
// 最新一筆證據是否新鮮且簽章核對通過。「載入＋呼叫」evidence.cjs 整段包在同一個 try/catch——
// 缺檔／語法壞掉／執行時丟例外／少了匯出，任何一種壞法都擋下，不讓例外一路丟到頂層的 fail-open
// catch（見檔尾 stdin handler）而被誤判成「沒事，放行」。
function verifyEvidence(content, filePath, cwd) {
  if (hasUncheckedAcceptance(content)) return BLOCK(uncheckedAcceptanceMessage(filePath));

  let ev, code;
  try {
    ev = loadEvidence();
    const root = ticketRootFromPath(filePath) ?? cwd;
    code = ev.checkLatestEvidence(content, filePath, root, ONE_DAY_MS);
  } catch {
    return BLOCK(evidenceModuleFailureMessage(filePath));
  }

  switch (code) {
    case 'ok': return PASS;
    case 'no-secret': return BLOCK(missingSecretMessage(filePath, ev.SECRET_PATH));
    case 'no-entry': return BLOCK(noEvidenceMessage(filePath));
    case 'stale': return BLOCK(staleMessage(filePath));
    case 'no-sig': return BLOCK(missingSigMessage(filePath));
    case 'unsigned': return BLOCK(unsignedMessage(filePath));
    case 'mismatch': return BLOCK(mismatchMessage(filePath));
    default: return BLOCK(evidenceModuleFailureMessage(filePath)); // 未知代碼（含 undefined）一律擋
  }
}

// Edit／apply_patch 共用：從磁碟讀「編輯前」的現檔內容來驗證（變更片段裡通常沒有
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
    const isTicket = TICKET_PATH_RE.test(marker.path);
    const isNextRound = !isTicket && NEXT_ROUND_PATH_RE.test(marker.path);
    if (!isTicket && !isNextRound) continue;

    const end = i + 1 < markers.length ? markers[i + 1].idx : lines.length;
    const segment = lines.slice(marker.idx, end).join('\n');
    if (!STATUS_DONE_ADDED_RE.test(segment)) continue;

    if (isNextRound) return BLOCK(nextRoundMessage(marker.path)); // 下輪待辦抽屜：不驗、直接擋

    const absPath = resolve(cwd, marker.path);
    const r = finalizeDoneCheck(verifyFromDisk(absPath, cwd), segment, cwd, absPath);
    if (r.block) return r;
  }
  return PASS;
}

// ---------------------------------------------------------------------------
// 定稿 UI 凍結守衛（見檔頭說明）：判定本身在 gates/frozen-guard.mjs（決議 030 抽出，Bash／PowerShell
// 那條路的 pre-tool-use.mjs 也呼叫同一份）；本檔只負責依工具形狀取出目標路徑。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 解凍回凍檢查（本輪新增）：關票（status: done）驗簽通過後，再核對 design-frozen.json 的 `log`——
// 若有路徑解凍過（action: unfreeze）但依 log 陣列順序之後沒有同路徑的 refreeze／freeze、且該路徑
// 目前也不在 `frozen` 陣列內，視為「解凍後還沒回凍」。除非這張票要寫入的新內容裡「## 決議記錄」
// 段落已含該路徑字串（等同已寫明原因），否則擋下——把 phase-build.md「撞到凍結怎麼辦」那套本來只
// 在出貨階段靠 Spec 軸人工核對的紀律，提早搬到關票這一步機器擋。design-frozen.json 不存在或解析
// 失敗一律 fail-open（跳過，不影響沒用到定稿凍結機制的專案）；只在「這次編輯把票的 status 改成
// done」的情境下觸發，其他編輯不查。
// 兩處鏡像修復：①「## 決議記錄」的搜尋來源除了這次編輯的片段，另外併入磁碟現檔——Edit 只帶
// new_string、apply_patch 只帶 diff segment，決議記錄多半已經寫在磁碟其他地方，只看片段必然找不到
// （見 finalizeDoneCheck）。②未回凍判定以「這次關的票號」為範圍——從票檔路徑（`tickets/T-NNN-*.md`
// 慣例）取出票號，只比對 log 裡帶同一個 `ticket` 欄的 unfreeze／refreeze 事件；沒有 `ticket` 欄的舊
// 格式記錄維持不分票的舊行為（見 computeUnrefrozenPaths）。否則同一輪內任何一張票解凍過的路徑，
// 會讓輪內所有其他票關票都被擋，除非每張票各自重抄一次決議記錄。
// ---------------------------------------------------------------------------
const DECISION_HEADING_RE = /^##\s*決議記錄.*$/m;
// 票檔路徑裡的票號（`tickets/T-NNN-slug.md` 慣例，見 ticket-template.md「命名規則」）。
const TICKET_ID_RE = /[\\/]tickets[\\/](T-\d+)/i;

function extractTicketId(filePath) {
  const m = String(filePath).match(TICKET_ID_RE);
  return m ? m[1].toUpperCase() : null;
}

// 讀 design-frozen.json 的 frozen／log 兩個陣列；檔案不存在、不是合法 JSON、或 frozen 缺欄／不是
// 陣列，一律回 null（呼叫端 fail-open，跳過此檢查）——與 readFrozenList 同一套 fail-open 判準一致，
// 不把「frozen 缺欄」誤判成「frozen 是空陣列」照樣往下驗（空陣列＝確實沒東西被凍結，缺欄＝格式本身
// 不對，不該被此檢查依賴）。
function readDesignFrozenLog(cwd) {
  try {
    const p = join(resolve(cwd), '.constellation', 'design-frozen.json');
    const data = JSON.parse(stripBom(readFileSync(p, 'utf8')));
    if (!data || typeof data !== 'object' || !Array.isArray(data.frozen)) return null;
    const frozen = data.frozen.filter(f => typeof f === 'string' && f.length);
    const log = Array.isArray(data.log) ? data.log : [];
    return { frozen, log };
  } catch {
    return null;
  }
}

// 依 log 陣列順序逐筆推算每個 path 的最終解凍狀態：遇到 unfreeze 記為未回凍、遇到 refreeze／freeze
// 記為已回凍——最後一筆事件即代表現況，等同「每筆 unfreeze 之後有沒有同 path 的 refreeze/freeze」逐
// 筆核對。**按票號分流**：entry.ticket 有寫（新格式，見 phase-build.md 的 log 寫法）就併入該票自己
// 的狀態機，只有 `currentTicket` 自己造成的未回凍才算數，不受同輪其他票的解凍狀態影響；entry.ticket
// 沒寫（沿用舊格式或手動補的記錄）退回「不分票」的舊行為——任何一張票關票都要擋，不因為新增分流就
// 放寬既有紀律。**路徑比對正規化**：分組 key 與 frozen 陣列的比對一律先經 normalizeRepoRelPath（與
// checkFrozenPath 同一套正規化：反斜線轉正斜線、去 repo 根前綴、小寫）再比對，避免 log 與 frozen 兩邊
// 分隔符或大小寫寫法不同就誤判成「還沒回凍」；輸出仍用原始寫法的 path（供訊息顯示與「## 決議記錄」
// 內文比對，正規化後的小寫字串不該拿去跟人寫的原文做子字串比對）。action 比對前一律 toLowerCase，
// 不因大小寫誤判事件種類而整筆被跳過。回傳目前仍「未回凍」且不在 frozen 陣列內、與 currentTicket
// 有關的 path 清單（原始寫法）。
function computeUnrefrozenPaths(log, frozen, currentTicket, cwd) {
  const scoped = new Map();   // key: 正規化 path + ticket，只算與 currentTicket 同號的
  const unscoped = new Map(); // key: 正規化 path，沒寫 ticket 欄的舊格式記錄，不分票
  for (const entry of log) {
    const rawPath = entry && entry.path;
    if (typeof rawPath !== 'string' || !rawPath) continue;
    const normPath = normalizeRepoRelPath(rawPath, cwd);
    const ticket = entry && typeof entry.ticket === 'string' && entry.ticket ? entry.ticket.toUpperCase() : null;
    const action = entry && typeof entry.action === 'string' ? entry.action.toLowerCase() : '';
    const isRefrozen = action === 'refreeze' || action === 'freeze';
    const isUnfreeze = action === 'unfreeze';
    if (!isRefrozen && !isUnfreeze) continue;
    if (ticket) scoped.set(`${normPath}\u0001${ticket}`, { path: rawPath, normPath, ticket, isRefrozen });
    else unscoped.set(normPath, { path: rawPath, isRefrozen });
  }
  const frozenSet = new Set(frozen.map(f => normalizeRepoRelPath(f, cwd)));
  const out = [];
  for (const { path, normPath, ticket, isRefrozen } of scoped.values()) {
    if (isRefrozen || frozenSet.has(normPath)) continue;
    if (currentTicket && ticket === currentTicket) out.push(path);
  }
  for (const [normPath, { path, isRefrozen }] of unscoped) {
    if (!isRefrozen && !frozenSet.has(normPath)) out.push(path);
  }
  return [...new Set(out)];
}

function unfreezeRefreezeMessage(paths) {
  return [
    'Constellation 關票刷卡機：擋下——關票前 design-frozen.json 顯示以下路徑解凍後尚未回凍，且這張票的' +
      '「## 決議記錄」未寫明原因：',
    ...paths.map(p => `  - ${p}`),
    '  → 出路擇一：',
    '    1. 補一筆 refreeze（或 freeze）記錄，把該檔重新納入 frozen 名單；',
    '    2. 在這張票的「## 決議記錄」段落寫明保留解凍狀態的原因（內文需含該路徑字串）。',
  ].join('\n');
}

// newContent：這次編輯要寫入的新內容（Write 的 content／Edit 的 new_string／apply_patch 的 diff
// 片段，外加呼叫端併入的磁碟現檔），用來判斷「## 決議記錄」是否已寫明未回凍的路徑。currentTicket：
// 這次關的票號（從票檔路徑取出），用來把未回凍判定限縮到這張票
// 自己造成的部份，見 computeUnrefrozenPaths。
function checkUnfreezeRefreeze(newContent, cwd, currentTicket) {
  const data = readDesignFrozenLog(cwd);
  if (!data) return null; // 檔案不存在或解析失敗 → fail-open，跳過

  const unresolved = computeUnrefrozenPaths(data.log, data.frozen, currentTicket, cwd);
  if (!unresolved.length) return null;

  const section = sectionOf(newContent, DECISION_HEADING_RE);
  const stillUnresolved = unresolved.filter(p => !section.includes(p));
  if (!stillUnresolved.length) return null;

  return BLOCK(unfreezeRefreezeMessage(stillUnresolved));
}

// 關票驗簽放行之後、回 PASS 之前的收尾：驗簽本身已經擋下就直接回傳那個結果，沒擋下才補做解凍回凍
// 檢查——兩者各自獨立判定，前者擋下不代表後者不用查（順序上驗簽先跑，故這裡先短路）。
// filePath：這次要關的票檔路徑。①併入磁碟現檔內容一起搜尋「## 決議記錄」——Edit／apply_patch 只帶
// 變更片段，決議記錄多半已經寫在磁碟其他地方，只看片段找不到（Write 本來就帶完整內容，併入磁碟版
// 不影響結果，讀不到就只用 newContent，維持 fail-open）。②從路徑取出這次關的票號，交給
// checkUnfreezeRefreeze 把未回凍判定限縮到這張票自己造成的部份（見 computeUnrefrozenPaths）。
// ③root 一律先試從票檔路徑切出來（見 ticketRootFromPath），切不到才退回 cwd——理由同 verifyEvidence。
function finalizeDoneCheck(verifyResult, newContent, cwd, filePath) {
  if (verifyResult.block) return verifyResult;
  let combined = newContent;
  if (filePath) {
    try { combined = newContent + '\n' + stripBom(readFileSync(filePath, 'utf8')); } catch { /* fail-open：讀不到就只用 newContent */ }
  }
  const currentTicket = filePath ? extractTicketId(filePath) : null;
  const root = filePath ? (ticketRootFromPath(filePath) ?? cwd) : cwd;
  return checkUnfreezeRefreeze(combined, root, currentTicket) || PASS;
}

// apply_patch：對 patch 內全部 `*** Update File:` 路徑逐一檢查凍結（沿用 checkApplyPatch 同一套
// marker 解析邏輯；新增/刪除檔案不會撞到既有凍結名單裡的既存檔案路徑判斷，故只看 Update File）。
function checkFrozenApplyPatch(patchText, cwd) {
  const lines = patchText.split(/\r?\n/);
  const markers = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PATCH_FILE_MARKER_RE);
    if (m) markers.push({ kind: m[1], path: m[2].trim() });
  }
  for (const marker of markers) {
    if (marker.kind !== 'Update File') continue;
    const r = checkFrozenPath(resolve(cwd, marker.path));
    if (r) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 現況覆蓋閘門（design-baseline；DESIGN.md §3）：定稿凍結（寫入 design-frozen.json 且 frozen 非空）
// 之前，必須存在 `.constellation/design-baseline.json`，證明本輪每張畫面在生成前做過「全新 vs 改造」
// 的判別，且改造型畫面的現況結構真的送上去過（推現況元件或從真 code 抽精確結構，sources 記來源檔）
// ——防止改造型畫面沒把現況送上設計服務、憑文字畫出相似新頁面。**此檢查刻意 fail-closed**（baseline
// 缺失／壞 JSON／rework 缺 sources 都擋）——凍結是 design 收尾必經之路，這裡不擋就等於沒有閘門；
// 非 UI 專案不寫 design-frozen.json、不觸發。
// baseline 格式：{ "screens": [ { "screen": "<畫面名>", "kind": "new"|"rework",
//   "sources": ["<repo 相對路徑>", ...] } ] }——kind=rework 時 sources 必須非空且每個路徑存在。
// ---------------------------------------------------------------------------
const DESIGN_BASELINE_REL = '.constellation/design-baseline.json';

function baselineMessage(reason) {
  return [
    `Constellation 現況覆蓋閘門：擋下——要定稿凍結（寫入 design-frozen.json），但 ${DESIGN_BASELINE_REL} ${reason}。`,
    '  → design 階段動筆寫需求前，須逐張畫面判別「全新（new）vs 改造既有（rework）」並寫入該檔；',
    '    rework 的 sources 填現況結構的來源檔（推上設計系統的來源、或抽精確結構的 repo 檔案路徑），',
    '    這是防止設計服務憑文字畫出「相似新頁面」的硬檢查點（phase-design.md 步驟 2 的現況覆蓋檢查）。',
  ].join('\n');
}

// 寫入內容是否為「frozen 非空」的定稿凍結動作：Write 看 content、Edit/apply_patch 因為只有片段，
// 一律視為可能構成凍結（保守觸發——誤觸發的代價只是提醒補 baseline，漏放行的代價是整個閘門形同
// 虛設）。content 解析失敗也保守觸發。
function writeContentFreezes(content) {
  try {
    const data = JSON.parse(stripBom(String(content)));
    return !!(data && Array.isArray(data.frozen) && data.frozen.length);
  } catch {
    return true;
  }
}

// root：已經找過的專案根（見 findProjectRoot／checkBaselineGuard），不是 hook 給的原始 cwd。
function checkDesignBaseline(root) {
  let rawBaseline;
  try {
    rawBaseline = readFileSync(join(root, '.constellation', 'design-baseline.json'), 'utf8');
  } catch {
    return BLOCK(baselineMessage('不存在'));
  }
  let data;
  try { data = JSON.parse(stripBom(rawBaseline)); } catch { return BLOCK(baselineMessage('不是合法 JSON')); }
  const screens = data && Array.isArray(data.screens) ? data.screens : null;
  if (!screens || !screens.length) return BLOCK(baselineMessage('的 screens 是空的'));
  for (const s of screens) {
    const name = s && typeof s.screen === 'string' ? s.screen : '(未命名畫面)';
    const kind = s && s.kind;
    if (kind !== 'new' && kind !== 'rework') {
      return BLOCK(baselineMessage(`裡「${name}」的 kind 不是 new/rework`));
    }
    if (kind === 'rework') {
      const sources = Array.isArray(s.sources) ? s.sources.filter(x => typeof x === 'string' && x.length) : [];
      if (!sources.length) return BLOCK(baselineMessage(`裡改造型畫面「${name}」的 sources 是空的——現況結構沒送上去`));
      for (const src of sources) {
        let ok = false;
        try { readFileSync(resolve(root, src)); ok = true; } catch { ok = false; }
        if (!ok) return BLOCK(baselineMessage(`裡「${name}」的 sources 路徑不存在於 repo：${src}`));
      }
    }
  }
  return null;
}

// 現況覆蓋閘門入口：目標是 design-frozen.json 且此寫入構成凍結 → 驗 baseline。回 BLOCK 或 null。
// root 一律從目標檔（或 apply_patch 用 cwd 解析後的起點）往上找第一個 .constellation（見
// findProjectRoot）——理由同 checkFrozenPath：hook 的 cwd 不一定等於專案根（見 P3）。
function checkBaselineGuard(tool, ti, input) {
  const cwd = resolveCwd(input);

  if (tool === 'Write' || tool === 'Edit') {
    const filePath = String(ti.file_path ?? '');
    if (!filePath) return null;
    const root = findProjectRoot(dirname(filePath));
    const isFrozenFile = DESIGN_FROZEN_PATH_RE.test(filePath) || normalizeRepoRelPath(filePath, root) === DESIGN_FROZEN_REL;
    if (!isFrozenFile) return null;
    if (tool === 'Write' && !writeContentFreezes(ti.content)) return null; // 清空歸檔不觸發
    return checkDesignBaseline(root);
  }

  const patchText = typeof ti.command === 'string' ? ti.command : '';
  if (patchText && /(^|[\\/])\.constellation[\\/]design-frozen\.json/i.test(patchText) && /\*\*\* (Update|Add) File:/.test(patchText)) {
    return checkDesignBaseline(findProjectRoot(resolve(cwd)));
  }
  return null;
}

// 統一入口：依工具型態取出目標檔案路徑（Write／Edit 用 file_path；apply_patch 用 patch 文字裡的
// Update File 路徑），交給 checkFrozenPath／checkFrozenApplyPatch 判定。回 BLOCK(...) 或 null
// （沒事，呼叫端繼續往下走既有的 done 票檢查）。
function checkFrozenGuard(tool, ti, input) {
  if (tool === 'Write' || tool === 'Edit') {
    const filePath = String(ti.file_path ?? '');
    if (!filePath) return null;
    return checkFrozenPath(filePath);
  }

  const patchText = typeof ti.command === 'string' ? ti.command : '';
  if (patchText) return checkFrozenApplyPatch(patchText, resolveCwd(input));

  return null;
}

// ---------------------------------------------------------------------------
// 純判定（不碰 stdin/exit），方便日後測試或整合呼叫。回 { block, message? }。
// ---------------------------------------------------------------------------
export function closeGateCheck(input) {
  const tool = input.tool_name ?? input.toolName ?? '';
  const ti = input.tool_input ?? input.toolInput ?? {};

  // 定稿 UI 凍結守衛先檢查——與下面的 done 票檢查各自獨立觸發，不因其中一項 PASS 就跳過另一項。
  const frozenBlock = checkFrozenGuard(tool, ti, input);
  if (frozenBlock) return frozenBlock;

  // 現況覆蓋閘門（design-baseline）——攔「定稿凍結」動作，驗改造型畫面的現況結構已送上去。
  const baselineBlock = checkBaselineGuard(tool, ti, input);
  if (baselineBlock) return baselineBlock;

  // 下輪待辦抽屜守衛（附帶）：抽屜裡的票不驗、不關，見 checkNextRoundGuard。
  const nextRoundBlock = checkNextRoundGuard(tool, ti);
  if (nextRoundBlock) return nextRoundBlock;

  if (tool === 'Write') {
    const filePath = String(ti.file_path ?? '');
    if (!filePath || !TICKET_PATH_RE.test(filePath)) return PASS;
    const content = ti.content;
    if (typeof content !== 'string' || !STATUS_DONE_RE.test(content)) return PASS;
    const cwd = resolveCwd(input);
    return finalizeDoneCheck(verifyEvidence(content, filePath, cwd), content, cwd, filePath);
  }

  if (tool === 'Edit') {
    const filePath = String(ti.file_path ?? '');
    if (!filePath || !TICKET_PATH_RE.test(filePath)) return PASS;
    const newString = ti.new_string ?? ti.newString;
    if (typeof newString !== 'string' || !STATUS_DONE_RE.test(newString)) return PASS;
    const cwd = resolveCwd(input);
    return finalizeDoneCheck(verifyFromDisk(filePath, cwd), newString, cwd, filePath);
  }

  // Codex apply_patch：不嚴格卡 tool_name（Codex 端的實際 tool_name 可能是 apply_patch 或其他
  // 殼名），只要輸入形狀帶 patch 文字就進這條分支——matcher 層（hooks.codex.json）已經只放行
  // Edit|Write|apply_patch 三種工具進來，這裡再檢查形狀是雙重保險。patch 文字讀 tool_input.command
  // ——Codex 官方 payload 把 apply_patch 內容放在這個欄位，不是 patch 欄位。
  const patchText = typeof ti.command === 'string' ? ti.command : '';
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
