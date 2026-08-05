#!/usr/bin/env node
// Constellation 閘門 3 —— session 開場注入（SessionStart hook）。
// 純讀檔：掃 {root}/.constellation/ 重建現況組成繁中摘要，供 runtime 注入開場。DESIGN.md §4／§5 閘門 3。
// 注入走「純導航模式」（單一形狀，與專案規模解耦）：置頂「開工前必讀」強制讀檔指令＋
// ①票況（tickets/*.md 的 status／blocked-by／票名／「## 驗收條件」勾選進度）②HISTORY.md 最近輪次
// ③decisions/ 一行摘要（總筆數＋最近編號範圍＋查法，不逐筆列標題）④CONTEXT.md 一行摘要（行數＋詞條數）。
// ③④刻意不列清單：清單會隨決議數量單調成長吃光額度，且截斷方向是「越舊越先丟」，而越舊的往往
// 越根本（早期那批地基決議），丟掉比長度撞線更傷；改為只給座標與查法，內文一律引導 Read／搜尋——
// 不注全文是因為 runtime 對 hook 注入有 10,000 字元硬門檻，超線整包被持久化、開場只剩 2KB 預覽（比索引更糟）；
// 知識軌單調成長，任何活躍專案遲早撞線，故一律導航（見 .constellation/decisions/002）。
// 知識軌每段獨立 fail-open——單段壞檔只少那一段，不拖垮票況。
// root 解析：git rev-parse --show-toplevel（在 cwd 下跑），失敗 fallback cwd（與 gates/commit-gate.mjs
// 的 resolveRepoRoot 同一套規則）——在子目錄下開 session 也掃得到專案根的 .constellation。
// 沒有 .constellation/ 的專案（非 Constellation 專案）一律靜默 exit 0，不干擾。
// 任何解析異常 fail-open：寧可少報一張票，也不 crash session 開場。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// R6：驗證 runner 的絕對路徑（不靠使用者猜相對路徑、不受呼叫時 cwd 影響），由本檔實際所在
// 目錄（gates/）推導出來——避免相對路徑在不同 cwd 下指到錯誤位置（路徑注入/誤觸風險）。
const GATES_DIR = dirname(fileURLToPath(import.meta.url));
const VERIFY_RUNNER_ABS_PATH = join(GATES_DIR, 'verify-runner.mjs');

const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// 從票檔全文解析出：票名（首行 # 標題）、status、blocked-by、驗收條件 done/total。
// 只在「metadata 區」（標題之後、第一個 ## section 之前）找 status/blocked-by，
// 避免票的目標／決議記錄裡偶然出現同名字眼被誤判成欄位。
function parseTicket(raw) {
  const lines = String(raw).split(/\r?\n/);
  let title = '';
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.startsWith('#')) { title = t.replace(/^#+\s*/, '').trim(); bodyStart = i + 1; }
    break; // 只看第一個非空行；不是標題也停止往下找（票檔理應以 # 標題起頭）
  }
  let status = '';
  let blockedBy = '';
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line.trim())) break; // 進入第一個 section，metadata 區結束
    if (!status) {
      const m = line.match(/^\s*status\s*:\s*([^#\r\n]*)/i);
      if (m) status = m[1].trim();
    }
    const mb = line.match(/^\s*blocked-by\s*:\s*([^#\r\n]*)/i);
    if (mb) blockedBy = mb[1].trim();
  }
  let done = 0, total = 0;
  const secIdx = lines.findIndex(l => /^##\s*驗收條件/.test(l.trim()));
  if (secIdx >= 0) {
    for (let i = secIdx + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^##\s/.test(t)) break;
      const m = t.match(/^-\s*\[([ xX])\]/);
      if (m) { total++; if (m[1].toLowerCase() === 'x') done++; }
    }
  }
  return { title, status: status.toLowerCase(), blockedBy, done, total };
}

const STATUSES = ['open', 'in-progress', 'blocked', 'done'];

// 導航模式各段上限（DESIGN.md §4「接續」）。索引級內容成長極慢，這些只是防怪檔的保險。
const DECISION_LIST_MAX = 20;        // decisions/ ≤ 此數才逐筆列標題；超過只給「總數＋最近編號範圍＋查法」
const HISTORY_MAX_LINES = 40;        // HISTORY.md（最新在最上，取檔案開頭即最近輪次）
const MAP_INDEX_MAX_LINES = 55;      // MAP.md 只注入「模組索引」表；其餘章節同樣走導航靠 Read
const SUMMARY_MAX_CHARS = 9000;      // 總量 failsafe：runtime 10k 字元門檻的安全線，超線硬截保可見

function readTextSafe(p) {
  try { return stripBom(readFileSync(p, 'utf8')); } catch { return null; }
}

// 去尾端空行後截到上限；超限時補一行指路。回傳行陣列。
function capLines(text, max, refPath) {
  const lines = String(text).split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `…（其餘 ${lines.length - max} 行略，全文見 ${refPath}）`];
}

// MAP.md 的同步點標記：值可能是佔位字串（樣板剛落地、還沒跑過同步），所以抽出來後
// 還要驗形狀——只有 hex 樣的才當真 sha，PLACEHOLDER_COMMIT／<sha>／TODO 一律視為「尚未標記」。
const MAP_SYNCED_AT_RE = /<!--\s*constellation-map-synced-at\s*:\s*(\S+?)\s*-->/i;
const looksLikeSha = s => /^[0-9a-f]{4,40}$/i.test(s);

// 過期偵測：地圖記的是「什麼東西在哪個路徑」，不記檔案內容，所以純改內容不會讓它過期——
// 只有新增（A）／刪除（D）／改名（R）才會讓「在哪」這件事失準，故 --diff-filter=ADR。
// 這樣同步點放久一點也不會被日常改 code 洗出滿江紅的假警報。
function mapStaleWarning(root, sha) {
  let out;
  try {
    out = execFileSync('git', ['-C', root, 'diff', '--name-status', `${sha}..HEAD`, '--diff-filter=ADR'],
      { maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  } catch { return null; } // sha 不存在／非 git repo／git 缺席 → 這個檢查整個略過，不擋不吵
  const changed = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const p = cols[cols.length - 1].trim(); // R 是「舊路徑\t新路徑」，取末欄即改名後的位置
    if (!p) continue;
    if (/^(\.constellation|node_modules|dist|test-results|\.git)\//.test(p)) continue; // 地圖不記這些
    // 文件性目錄底下的純文字檔搬來搬去不影響「程式碼在哪」，不值得為它報過期。
    if (/(^|\/)(docs|specs)\//i.test(p) && /\.(md|txt|json)$/i.test(p)) continue;
    changed.push(p);
  }
  if (!changed.length) return null;
  return `⚠ 地圖可能已過期：上次同步（${sha.slice(0, 7)}）之後有 ${changed.length} 個檔案新增/刪除/改名` +
    `（例：${changed.slice(0, 3).join('、')}）。動工前請先核對 MAP.md。`;
}

// 專案現況地圖導航：只注入「模組索引」那一章（東西在哪、進哪個檔改），資料表／已知資料缺口／
// 地雷等章節留在檔案裡靠置頂指令引導 Read——與知識軌同一套導航紀律，不讓地圖把注入額度吃光。
// 整段 fail-open：地圖是輔助資訊，壞檔／git 異常都只是少這一段，絕不拖垮票況注入。
function buildMapSection(base, root) {
  try {
    const raw = readTextSafe(join(base, 'MAP.md'));
    if (!raw || !raw.trim()) return null;
    const all = raw.split(/\r?\n/);
    const lineCount = all.length;

    // 章節標題可能帶編號與括號補述（「## 一、模組索引（開場注入用…）」），故只認關鍵字不認整串。
    const start = all.findIndex(l => /^##\s.*模組索引/.test(l.trim()));
    let body = [];
    if (start >= 0) {
      let end = all.length;
      for (let i = start + 1; i < all.length; i++) {
        if (/^##\s/.test(all[i])) { end = i; break; } // 下一個二級標題為界（### 子節仍算本章）
      }
      body = all.slice(start + 1, end);
      while (body.length && !body[0].trim()) body.shift();
    }
    const shown = body.length
      ? capLines(body.join('\n'), MAP_INDEX_MAX_LINES, '.constellation/MAP.md')
      : ['  （MAP.md 尚無模組索引章節——請直接 Read 原檔）'];

    const m = raw.match(MAP_SYNCED_AT_RE);
    const sha = m && looksLikeSha(m[1]) ? m[1] : null;
    const note = sha ? mapStaleWarning(root, sha)
      : '· 地圖尚未標記同步點（缺 constellation-map-synced-at），無法判斷是否過期。';

    const lines = ['【專案現況地圖（.constellation/MAP.md，完整內容含資料表、已知資料缺口與地雷請 Read 原檔）】'];
    if (note) lines.push(note); // 警告放表格前面，免得被 55 行索引蓋掉看不見
    lines.push(...shown);
    return { text: lines.join('\n'), lineCount };
  } catch { return null; } // fail-open
}

// CONTEXT.md 導航：只給「多少行、多少詞條」，詞條名與內文一律由置頂指令引導 Read 全文。
// 詞條數兩種寫法都算，取較大者：專案可能用 `- **詞**：` 條列，也可能用 `## 詞` 分節；
// 只認一種會誤判——條列式檔案常有 `##` 分組標題，分節式檔案內文也常有偶然的 `- **粗體**`。
function buildContextSection(base) {
  const raw = readTextSafe(join(base, 'CONTEXT.md'));
  if (!raw || !raw.trim()) return null;
  const lineCount = raw.split(/\r?\n/).length;
  const bulletTerms = [...raw.matchAll(/^\s*-\s*\*\*(.+?)\*\*/gm)].length;
  const headingTerms = [...raw.matchAll(/^##\s+(.+)$/gm)].length;
  const termCount = Math.max(bulletTerms, headingTerms);
  const scale = termCount ? `共 ${lineCount} 行、${termCount} 個詞條` : `共 ${lineCount} 行`;
  return {
    text: `【專案詞彙（.constellation/CONTEXT.md）】${scale}，動手前請 Read 全文。`,
    lineCount,
  };
}

function buildDecisionsSection(base) {
  const dir = join(base, 'decisions');
  let files = [];
  // 只收數字開頭的正式決策（slug 可缺，落檔時少打 slug 也不無聲消失）；grill-close.md 是流程標記不在此列。
  try {
    files = readdirSync(dir)
      .filter(f => /^\d+([-_].*)?\.md$/i.test(f))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  } catch { return null; }
  if (!files.length) return null;

  // 每檔的索引行：首個一級標題「# 」優先（(?!#) 擋掉 ## 二級標題誤中），讀不到退回檔名。
  const titleOf = f => {
    const raw = readTextSafe(join(dir, f));
    const m = raw && raw.match(/^#(?!#)\s*(.+)$/m);
    return m ? `${f.replace(/\.md$/i, '')}：${m[1].trim()}` : f.replace(/\.md$/i, '');
  };

  const lines = [`【決策記錄（.constellation/decisions/）】共 ${files.length} 筆，編號越大越新，內文請 Read 原檔。`];
  if (files.length <= DECISION_LIST_MAX) {
    // 小專案：全部列得完就照舊逐筆列標題，沒有截斷問題，也省一趟查目錄。
    for (const f of files) lines.push(`  - ${titleOf(f)}`);
  } else {
    // 大專案：只給座標。刻意不試圖解析「第幾輪」——決議檔沒有可靠的機讀輪次邊界，
    // 硬猜會給出假精確；用固定的「最近 N 筆」當範圍即可，反正真要看還是得列目錄。
    const numOf = f => (f.match(/^\d+/) || [f])[0];
    const recent = files.slice(-DECISION_LIST_MAX);
    lines.push(`  最近 ${recent.length} 筆：${numOf(recent[0])}~${numOf(recent[recent.length - 1])}`);
    lines.push('  查法：列目錄 `ls .constellation/decisions/` ／ 找特定主題用關鍵字搜檔名與內文');
  }
  return { text: lines.join('\n'), count: files.length };
}

function buildHistorySection(base) {
  const raw = readTextSafe(join(base, 'HISTORY.md'));
  if (!raw || !raw.trim()) return null;
  return { text: ['【出貨輪次史（.constellation/HISTORY.md，最新在上）】',
    ...capLines(raw, HISTORY_MAX_LINES, '.constellation/HISTORY.md')].join('\n') };
}

// 專案根沒有 runtime 原生每場必讀的專案地圖時提醒一句（生成留給 ship 收尾提議，不在開場動手）。
function claudeMdReminder(root) {
  if (existsSync(join(root, 'CLAUDE.md')) || existsSync(join(root, 'AGENTS.md'))) return null;
  return '· 提示：專案根尚無 CLAUDE.md／AGENTS.md（runtime 開場必讀的專案地圖）——下次 ship 收尾時可提議生成最小版。';
}

// repo root 解析：git rev-parse --show-toplevel，失敗 fallback cwd（與 commit-gate.mjs 鏡像）。
function resolveRepoRoot(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'],
      { maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'] }) // 靜默 stderr：非 git 目錄不漏 fatal 兩行
      .toString('utf8').trim();
    if (out) return out;
  } catch {} // 非 git repo／git 不存在等 → fallback cwd
  return cwd;
}

function buildSummary(cwd) {
  const root = resolveRepoRoot(cwd);
  const base = join(root, '.constellation');
  if (!existsSync(base)) return null; // 非 Constellation 專案，靜默

  const ticketsDir = join(base, 'tickets');
  let files = [];
  try { files = readdirSync(ticketsDir).filter(f => f.toLowerCase().endsWith('.md')); } catch { files = []; }

  const buckets = { open: [], 'in-progress': [], blocked: [], done: [] };
  let unknown = 0;
  for (const f of files) {
    let raw;
    try { raw = stripBom(readFileSync(join(ticketsDir, f), 'utf8')); } catch { continue; }
    let t;
    try { t = parseTicket(raw); } catch { continue; }
    const label = t.title || f.replace(/\.md$/i, '');
    if (STATUSES.includes(t.status)) buckets[t.status].push({ ...t, label });
    else unknown++;
  }

  const counts = STATUSES.map(s => `${s} ${buckets[s].length}`).join('、');
  const lines = [];
  lines.push(`【Constellation 專案現況】共 ${files.length} 張票 — ${counts}${unknown ? `（另有 ${unknown} 張狀態無法辨識）` : ''}`);

  if (buckets['in-progress'].length) {
    lines.push('進行中：');
    for (const t of buckets['in-progress']) {
      const progress = t.total ? `驗收條件 ${t.done}/${t.total} 已完成` : '尚無可勾選的驗收條件';
      lines.push(`  - ${t.label}（${progress}）`);
    }
  }
  if (buckets.blocked.length) {
    lines.push('被擋：');
    for (const t of buckets.blocked) {
      // Y11：blocked-by 留空不等於「沒交代原因」——票可能因驗收條件矛盾、外部依賴、決議記錄
      // 裡的其他理由而 blocked，不見得是「等其他票做完」這一種情境，措辭不要越俎代庖下判斷。
      const reason = t.blockedBy ? `等待 ${t.blockedBy.replace(/,/g, '、')} 完成` : 'blocked（原因見該票決議記錄）';
      lines.push(`  - ${t.label}（${reason}）`);
    }
  }
  // 知識軌導航（DESIGN.md §4「接續」）：每段獨立 try——單段解析炸掉只少那一段，票況照常注入。
  let map = null, ctx = null, dec = null, hist = null;
  try { map = buildMapSection(base, root); } catch { /* fail-open */ }
  try { ctx = buildContextSection(base); } catch { /* fail-open */ }
  try { dec = buildDecisionsSection(base); } catch { /* fail-open */ }
  try { hist = buildHistorySection(base); } catch { /* fail-open */ }

  // 置頂強制讀檔指令：知識本體不在注入裡——放最前面，任何情況下最先被看到。
  if (map || ctx || dec) {
    const reads = [];
    // 地圖排第一：動手前最先要知道的是「東西在哪」，其次才是詞彙。
    if (map) reads.push(`.constellation/MAP.md（專案現況地圖，全文 ${map.lineCount} 行）`);
    if (ctx) reads.push(`.constellation/CONTEXT.md（專案詞彙與業務規則，全文 ${ctx.lineCount} 行）`);
    const parts = ['【開工前必讀】本專案知識軌不隨開場注入內文，下方只是座標。'];
    if (reads.length) parts.push(`動手任何工作前先 Read：${reads.join('＋')}。`);
    // 決議改成「講查法」而不是列清單：開場看不到清單≠沒有那筆決議，這句是防止模型
    // 因為索引消失就自行推論「本專案沒相關決議」而繞過既有拍板。
    if (dec) {
      parts.push(`決議在 .constellation/decisions/，共 ${dec.count} 筆，編號越大越新；` +
        '要查特定主題請列目錄或用關鍵字搜尋（檔名與內文都搜），不要假設沒看到就不存在。');
    }
    lines.unshift(parts.join(''));
  }
  if (map) lines.push(map.text); // 票況之後、知識軌之前：先知道東西在哪，再談脈絡
  if (hist) lines.push(hist.text);
  if (dec) lines.push(dec.text);
  if (ctx) lines.push(ctx.text);
  try { const r = claudeMdReminder(root); if (r) lines.push(r); } catch { /* fail-open */ }
  lines.push(`驗證 runner：node "${VERIFY_RUNNER_ABS_PATH}"`);

  let summary = lines.join('\n');
  // failsafe：索引級內容理論上不會超線；萬一撞上（極端怪檔），硬截保「開場可見」優先於完整——
  // 超過 runtime 10k 字元門檻會整包被持久化、只剩 2KB 預覽，比截斷更糟。
  if (summary.length > SUMMARY_MAX_CHARS) {
    summary = summary.slice(0, SUMMARY_MAX_CHARS) +
      '\n…（導航超過注入上限被截斷，完整現況請直接查看 .constellation/ 目錄）';
  }
  return summary;
}

// git 原生 pre-commit 兜底的冪等安裝（gates/precommit-install.mjs）。只在確認是 Constellation 專案後才呼叫。
// 動態 import 包在 try：檔案缺失／壞掉一律靜默略過，session 開場絕不因此失敗。
// 回傳要附進開場摘要的一行（首裝告知／warn 提醒），沒事回 null。
async function ensurePrecommit(root) {
  try {
    const mod = await import(pathToFileURL(join(GATES_DIR, 'precommit-install.mjs')).href);
    const r = mod.installPrecommit(root);
    if (r.installed) return '· 已為本 repo 裝上 git pre-commit 兜底——往後在終端機自己打 git commit，也會過 secrets／驗證垃圾檢查。';
    if (r.warn) return '⚠ ' + r.warn;
  } catch { /* fail-silent：安裝器缺失/例外都不影響開場 */ }
  return null;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => process.exit(0));
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', async () => {
  let input = {};
  try { input = JSON.parse(stripBom(raw).trim() || '{}'); } catch { input = {}; }
  // cwd 多鍵名 fallback：Claude Code／Codex 慣用 cwd，防禦性再收兩個常見別名。
  const cwd = input.cwd ?? input.workspace_root ?? input.workingDirectory ?? process.cwd();

  let summary = null;
  try { summary = buildSummary(cwd); } catch { summary = null; }
  if (!summary) return process.exit(0); // 非 Constellation 專案：不注入、也不裝 pre-commit

  // summary 非 null＝確定是 Constellation 專案，此時才裝兜底。
  let notice = null;
  try { notice = await ensurePrecommit(resolveRepoRoot(cwd)); } catch { notice = null; }
  if (notice) summary += '\n' + notice;

  const out = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: summary } };
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
});
