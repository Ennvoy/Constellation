#!/usr/bin/env node
// Constellation 閘門 3 —— session 開場注入（SessionStart hook）。
// 純讀檔：掃 {root}/.constellation/ 重建現況組成繁中摘要，供 runtime 注入開場。DESIGN.md §4／§5 閘門 3。
// 注入四段：①票況（tickets/*.md 的 status／blocked-by／票名／「## 驗收條件」勾選進度）
// ②CONTEXT.md 全文 ③decisions/ 索引＋最近三筆全文 ④HISTORY.md 最近輪次（最新在檔案最上）。
// 各段有行數上限、超限截斷並指路原檔（防注入膨脹）；知識軌每段獨立 fail-open——單段壞檔只少那一段，不拖垮票況。
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

// 知識軌注入上限（DESIGN.md §4「接續」：各段設行數上限、超限截斷並指路原檔）。
const CONTEXT_MAX_LINES = 200;       // CONTEXT.md 全文
const DECISION_INDEX_MAX = 50;       // decisions/ 索引筆數（超過只列最近 N 筆）
const DECISION_RECENT = 3;           // 最近幾筆決策附全文
const DECISION_BODY_MAX_LINES = 15;  // 每筆決策全文上限
const HISTORY_MAX_LINES = 40;        // HISTORY.md（最新在最上，取檔案開頭即最近輪次）

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

function buildContextSection(base) {
  const raw = readTextSafe(join(base, 'CONTEXT.md'));
  if (!raw || !raw.trim()) return null;
  return ['【專案詞彙與業務規則（.constellation/CONTEXT.md）】',
    ...capLines(raw, CONTEXT_MAX_LINES, '.constellation/CONTEXT.md')].join('\n');
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

  const lines = [`【決策記錄（.constellation/decisions/）】共 ${files.length} 筆：`];
  const indexFiles = files.slice(-DECISION_INDEX_MAX);
  if (indexFiles.length < files.length) lines.push(`  （僅列最近 ${indexFiles.length} 筆，其餘見目錄）`);
  for (const f of indexFiles) lines.push(`  - ${titleOf(f)}`);

  const recent = files.slice(-DECISION_RECENT);
  lines.push(`最近 ${recent.length} 筆全文：`);
  for (const f of recent) {
    const raw = readTextSafe(join(dir, f));
    if (!raw) continue;
    for (const l of capLines(raw, DECISION_BODY_MAX_LINES, `.constellation/decisions/${f}`)) lines.push(`  ${l}`);
    lines.push('');
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

function buildHistorySection(base) {
  const raw = readTextSafe(join(base, 'HISTORY.md'));
  if (!raw || !raw.trim()) return null;
  return ['【出貨輪次史（.constellation/HISTORY.md，最新在上）】',
    ...capLines(raw, HISTORY_MAX_LINES, '.constellation/HISTORY.md')].join('\n');
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
  // 知識軌（DESIGN.md §4「接續」②③④）：每段獨立 try——單段解析炸掉只少那一段，票況照常注入。
  for (const build of [buildContextSection, buildDecisionsSection, buildHistorySection]) {
    try { const s = build(base); if (s) lines.push(s); } catch { /* fail-open */ }
  }
  try { const r = claudeMdReminder(root); if (r) lines.push(r); } catch { /* fail-open */ }
  lines.push(`驗證 runner：node "${VERIFY_RUNNER_ABS_PATH}"`);
  return lines.join('\n');
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
