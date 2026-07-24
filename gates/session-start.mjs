#!/usr/bin/env node
// Constellation 閘門 3 —— session 開場注入（SessionStart hook）。
// 純讀檔：掃 {root}/.constellation/tickets/*.md，解析 status／blocked-by／票名（首行 # 標題）與
// 「## 驗收條件」勾選進度，組成繁中摘要，供 runtime 注入開場。DESIGN.md §4／§5 閘門 3。
// root 解析：git rev-parse --show-toplevel（在 cwd 下跑），失敗 fallback cwd（與 gates/commit-gate.mjs
// 的 resolveRepoRoot 同一套規則）——在子目錄下開 session 也掃得到專案根的 .constellation。
// 沒有 .constellation/ 的專案（非 Constellation 專案）一律靜默 exit 0，不干擾。
// 任何解析異常 fail-open：寧可少報一張票，也不 crash session 開場。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// repo root 解析：git rev-parse --show-toplevel，失敗 fallback cwd（與 commit-gate.mjs 鏡像）。
function resolveRepoRoot(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { maxBuffer: 1 << 20 })
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
  lines.push(`驗證 runner：node "${VERIFY_RUNNER_ABS_PATH}"`);
  return lines.join('\n');
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => process.exit(0));
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(stripBom(raw).trim() || '{}'); } catch { input = {}; }
  // cwd 多鍵名 fallback：Claude Code／Codex 慣用 cwd，防禦性再收兩個常見別名。
  const cwd = input.cwd ?? input.workspace_root ?? input.workingDirectory ?? process.cwd();

  let summary = null;
  try { summary = buildSummary(cwd); } catch { summary = null; }
  if (!summary) return process.exit(0);

  const out = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: summary } };
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
});
