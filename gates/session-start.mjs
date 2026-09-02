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
const SERVE_ABS_PATH = join(GATES_DIR, 'serve.mjs');

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

const looksLikeSha = s => /^[0-9a-f]{4,40}$/i.test(s);
const MAP_REL_PATH = '.constellation/MAP.md';
const DEAD_PATH_MAX_REPORT = 5;       // 死路徑一次最多點名幾條（其餘只給總數，免得洗掉後面的模組索引）
const SEMANTIC_DRIFT_MAX_REPORT = 4;  // 語意漂移是可能級提示，比死路徑更該克制，報更少

// 過期基準：地圖自己「最後一次被 commit 的那個 commit」，由閘門自己算，不看任何人工標記
// （DESIGN.md §4）。人工 sha 要求「改地圖」與「改標記」每次都同時做到，漏一次基準就永遠停在
// 過去、警示從此常亮，而天天亮的警示等於沒亮。回 null 代表「此刻不必比對」：
// 地圖有未提交改動＝正在校對，拿任何歷史 commit 當基準都會報出其實已經處理掉的假警報。
function mapBaselineCommit(root) {
  const git = args => execFileSync('git', ['-C', root, ...args],
    { maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  try {
    if (git(['status', '--porcelain', '--', MAP_REL_PATH]).trim()) return null;
    const sha = git(['log', '-1', '--format=%H', '--', MAP_REL_PATH]).trim();
    return looksLikeSha(sha) ? sha : null; // 從未被 commit（新落檔的地圖）→ 空字串 → 不比對
  } catch { return null; } // 非 git repo／git 缺席 → 這個檢查整個略過，不擋不吵
}

// 第①道：死路徑點名。地圖寫的路徑若檔案已經不在，那是**確定**過期，而且指得到是哪一行——
// 這是全套機制裡唯一能精準到行、且修完就會熄的檢查（第②道只能說「某處可能過期」）。
// 零誤報優先：只認「去掉尾斜線後仍含 /」的字串。這條規則同時擋掉三類非路徑的反引號內容——
// 指令（含空格）、資料表名與單一檔名（無 /）、以及地圖裡常見的省略寫法（`overview/` 這種
// 承前省略前綴的片段，去尾斜線後就不含 / 了）；含 glob 的樣式無法用 existsSync 驗，一併略過。
// 反引號內外都抽：地圖的缺口／地雷段大量在括號裡裸寫來源檔（「（data-health.md；scripts/db/x.mjs）」），
// 只認反引號會漏掉一半。誤報由呼叫端的「頂層須存在於 repo 根」把關——那道足以擋掉日期
// （2026/08/04 的頂層 2026 不存在）等偶然含斜線的字串。
const PATH_TOKEN_RE = /[\w.@()[\]{}~-]+(?:\/[\w.@()[\]{}~-]+)+\/?/g;
// 裸檔名（無目錄）：地圖第二段的「定義在哪」直接寫 migration 檔名不寫路徑，只抽路徑會整段抓不到。
// 純比對用，不驗存在性（不知道它在哪）；泛用檔名排除掉——一個 repo 裡幾十個 route.ts，命中無意義。
const FILE_TOKEN_RE = /\b[\w.@-]+\.[a-z0-9]{1,6}\b/gi;
const GENERIC_FILENAMES = /^(index|route|page|layout|types?|utils?|config|main|app|db|schema)\.[a-z0-9]+$/i;

// 抽出一行裡的路徑 token（含目錄分隔、可從 repo 根解析者）。
function extractPaths(line) {
  const out = [];
  for (const m of line.matchAll(PATH_TOKEN_RE)) {
    // glob 樣式（`app/api/_lib/stats-*.ts`）會被切成 `app/api/_lib/stats-` 這種前綴，
    // 前綴當然「不存在」，直接拿去驗就是誤報。但整段丟掉又太可惜——退一層取父目錄仍然有效：
    // 目錄沒了代表這行確實過期，目錄有變動代表這行該複驗。
    const next = line[m.index + m[0].length];
    if (next === '*' || next === '?') {
      const cut = m[0].lastIndexOf('/');
      const dir = cut > 0 ? m[0].slice(0, cut) : '';
      if (dir.includes('/')) out.push(dir);
      continue;
    }
    const rel = m[0].replace(/^\.\//, '').replace(/[/\\]+$/, '');
    if (!rel.includes('/')) continue;                           // 去尾斜線後仍要有目錄分隔
    if (/[-._]$/.test(rel)) continue;                           // 以連字號／點／底線收尾＝被切斷了
    if (rel.startsWith('/') || /^[a-z]+:/i.test(rel)) continue; // 絕對路徑／URL／協定字串不驗
    out.push(rel);
  }
  return out;
}

// 第①道：死路徑點名。地圖寫的路徑若檔案已經不在，那是**確定**過期，而且指得到是哪一行——
// 這是全套機制裡唯一能精準到行、且修完就會熄的檢查（第②道只能說「某處可能過期」）。
function mapDeadPaths(raw, root) {
  const dead = [];
  const seen = new Set();
  const topExists = new Map(); // 頂層片段的存在性快取，同一份地圖大量重複 app/、lib/、scripts/
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const rel of extractPaths(lines[i])) {
      // 只驗「從 repo 根寫得起」的路徑：頂層片段必須真的存在於根。地圖為了精簡大量使用承前
      // 省略（同一列先寫 `app/api/activity/`，後面就接 `[id]/_lib/`、`admin/tokens/`、
      // `.../callcenter/projects/`），這些片段單看都含 /，卻不是從根解析得了的路徑——
      // 用「頂層存在」一次擋掉整類。代價是整個頂層目錄被搬走時這道不報（少報優於誤報）。
      const top = rel.slice(0, rel.indexOf('/'));
      if (!topExists.has(top)) topExists.set(top, existsSync(join(root, top)));
      if (!topExists.get(top)) continue;
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (!existsSync(join(root, rel))) dead.push({ line: i + 1, rel });
    }
  }
  return dead;
}

// 第②道：結構變動提示。地圖第一段記的是「什麼東西在哪個路徑」，只有新增（A）／刪除（D）／
// 改名（R）會讓「在哪」失準，故 --diff-filter=ADR；純改內容不動它，日常改 code 不會洗出假警報。
// 代價（DESIGN.md §4 已載明）：資料表口徑／缺口／地雷那三段是語意，這道測不出來。
// baseline..HEAD 的變更清單，一次拿齊給第②③道共用。git 在大 repo 上每次呼叫都是 2~3 秒的
// 固定成本（本機實測），而這是每場 session 都要跑的 hook——同樣的 diff 呼叫兩次是純浪費。
// 回傳 [{ status, path }]；status 首字母 A/D/R/M 由第②道自行過濾。
function mapChangedFiles(root, sha) {
  let out;
  try {
    out = execFileSync('git', ['-C', root, 'diff', '--name-status', `${sha}..HEAD`],
      { maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  } catch { return null; } // sha 不存在／非 git repo／git 缺席 → 這個檢查整個略過，不擋不吵
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const p = cols[cols.length - 1].trim(); // R 是「舊路徑\t新路徑」，取末欄即改名後的位置
    if (!p) continue;
    if (/^(\.constellation|node_modules|dist|test-results|\.git)\//.test(p)) continue; // 地圖不記這些
    rows.push({ status: cols[0].trim(), path: p });
  }
  return rows;
}

function mapStaleWarning(rows, sha) {
  const changed = [];
  for (const { status, path: p } of rows) {
    if (!/^[ADR]/.test(status)) continue; // 只看新增／刪除／改名
    // 文件性目錄底下的純文字檔搬來搬去不影響「程式碼在哪」，不值得為它報過期。
    if (/(^|\/)(docs|specs)\//i.test(p) && /\.(md|txt|json)$/i.test(p)) continue;
    changed.push(p);
  }
  if (!changed.length) return null;
  return `· 地圖最後更新（${sha.slice(0, 7)}）之後有 ${changed.length} 個檔案新增/刪除/改名` +
    `（例：${changed.slice(0, 3).join('、')}）——模組索引可能少了東西，動工前順手核對。`;
}

// 第③道：語意段落的來源歸因。第二～四段（資料表口徑／缺口／地雷）記的是語意，「內容改了但
// 檔名沒變」時第①②道都測不出來——機器讀不懂語意，這是硬限制，繞不過去。
// 能做的是退一步問「這條的依據還是原樣嗎」：這些條目幾乎都寫了自己的來源（migration 檔名、
// 腳本路徑、報告檔），來源在地圖更新後被動過，描述就有相當機率跟著失準。於是把「複驗整段
// 兩百多行」壓縮成「複驗這幾行」。**這是可能級提示，不是確定級**——來源動過不等於描述就錯，
// 但沒動過的行幾乎可以放心跳過，省下的正是複驗成本。
// 模組索引那段排除在外：它記路徑不記語意，內容變動本來就不該讓它過期（由第①②道負責）。
function mapSemanticDrift(raw, root, rows, skipFrom, skipTo, deadLines) {
  const changedPaths = new Set();
  const changedFiles = new Set();
  const changedDirs = new Set(); // 變更檔案的所有祖先目錄，讓「地圖寫目錄」也能 O(1) 命中
  for (const { path: p } of rows) {
    changedPaths.add(p);
    changedFiles.add(p.slice(p.lastIndexOf('/') + 1));
    for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) changedDirs.add(p.slice(0, i));
  }
  if (!changedPaths.size) return null;

  const hits = [];
  const topExists = new Map();
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (i >= skipFrom && i < skipTo) continue; // 模組索引段
    if (deadLines.has(i)) continue; // 已被第①道判定為確定過期，不必再用可能級提示重報一次
    const line = lines[i];
    let hit = null;
    let hasRealPath = false; // 這一行有沒有寫出「可從 repo 根解析」的完整路徑
    for (const rel of extractPaths(line)) {
      const top = rel.slice(0, rel.indexOf('/'));
      if (!topExists.has(top)) topExists.set(top, existsSync(join(root, top)));
      if (!topExists.get(top)) continue; // 承前省略片段，不算指名了路徑
      hasRealPath = true;
      if (changedPaths.has(rel) || changedDirs.has(rel)) { hit = rel; break; }
    }
    // 裸檔名只在「這行沒指名任何路徑」時才退而求其次——跨目錄同名檔會誤命中（同一個 repo 裡
    // 好幾支 activity.ts，改到 A 目錄那支卻報講 B 目錄那支的行），而已經寫出路徑的行不需要猜。
    if (!hit && !hasRealPath) {
      for (const m of line.matchAll(FILE_TOKEN_RE)) {
        const f = m[0];
        if (GENERIC_FILENAMES.test(f)) continue;
        if (changedFiles.has(f)) { hit = f; break; }
      }
    }
    if (hit) hits.push(`第 ${i + 1} 行 \`${hit}\``);
  }
  if (!hits.length) return null;
  const shown = hits.slice(0, SEMANTIC_DRIFT_MAX_REPORT).join('、');
  const more = hits.length > SEMANTIC_DRIFT_MAX_REPORT ? `…等 ${hits.length} 行` : '';
  return `· 語意段落有 ${hits.length} 行的來源在地圖更新後動過（${shown}${more}）` +
    `——資料表口徑／缺口／地雷是機器讀不懂的，請逐條複驗這幾行還算不算數。`;
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
    let end = start; // 模組索引段的行範圍［start, end），第③道要拿它排除這一段
    if (start >= 0) {
      end = all.length;
      for (let i = start + 1; i < all.length; i++) {
        if (/^##\s/.test(all[i])) { end = i; break; } // 下一個二級標題為界（### 子節仍算本章）
      }
      body = all.slice(start + 1, end);
      while (body.length && !body[0].trim()) body.shift();
    }
    const shown = body.length
      ? capLines(body.join('\n'), MAP_INDEX_MAX_LINES, '.constellation/MAP.md')
      : ['  （MAP.md 尚無模組索引章節——請直接 Read 原檔）'];

    // 三道過期檢查（DESIGN.md §4），一律放表格前面免得被 55 行模組索引蓋掉。
    // 順序＝確定性由高到低：死路徑（確定過期、指得到行）→ 結構變動 → 語意漂移（可能級）。
    const notes = [];
    const dead = mapDeadPaths(raw, root);
    if (dead.length) {
      const shownDead = dead.slice(0, DEAD_PATH_MAX_REPORT).map(d => `第 ${d.line} 行 \`${d.rel}\``).join('、');
      const more = dead.length > DEAD_PATH_MAX_REPORT ? `…等 ${dead.length} 處` : '';
      notes.push(`⚠ 地圖有 ${dead.length} 個路徑已不存在（${shownDead}${more}）——這幾行是確定過期，動工前先修掉。`);
    }
    const sha = mapBaselineCommit(root);
    const rows = sha ? mapChangedFiles(root, sha) : null; // 一次 diff，②③共用
    if (rows && rows.length) {
      const stale = mapStaleWarning(rows, sha);
      if (stale) notes.push(stale);
      const deadLines = new Set(dead.map(d => d.line - 1)); // 轉 0-based 供第③道去重
      const drift = mapSemanticDrift(raw, root, rows, start, end, deadLines);
      if (drift) notes.push(drift);
    }

    const lines = ['【專案現況地圖（.constellation/MAP.md，完整內容含資料表、已知資料缺口與地雷請 Read 原檔）】'];
    lines.push(...notes);
    lines.push(...shown);
    return { text: lines.join('\n'), lineCount, hazardCount: countMapHazards(all) };
  } catch { return null; } // fail-open
}

// 地圖「缺口／地雷」區的**條數**（不是內容）。只回一個數字，永遠一行——注入量與專案規模解耦
// 那條原則（決議 002）因此不受影響，而讀的人知道自己還有多少沒看過的坑。
//
// 為什麼值得多這一個數字（2026-08-17，實際踩過）：那兩區記的多半是**動手方式**的坑
// （測試怎麼跑、腳本怎麼下、查詢怎麼寫），光看模組索引不會意識到需要它；而它們正好不在注入
// 內容裡。當時的判斷是「只是回答問題、不是開工」而略過全文，結果撞上區裡早就寫著的那條
// （測試的還原機制會把剛匯入的資料日倒退回去）。
//
// 判準刻意寬鬆：標題含「地雷／缺口／未竟」的二級章節即算，`~~劃掉~~` 的條目是已解決不計。
// 專案沒有這種章節時回 0，呼叫端就不印那句——不同專案的地圖結構本來就不必一致。
function countMapHazards(allLines) {
  let inSection = false;
  let n = 0;
  for (const line of allLines) {
    if (/^##\s/.test(line)) { // ### 子節不中斷（第三個 # 不是空白，故不匹配）
      inSection = /^##\s.*(地雷|缺口|未竟)/.test(line.trim());
      continue;
    }
    if (!inSection) continue;
    const t = line.trim();
    if (/^-\s/.test(t) && !/^-\s*~~/.test(t)) n++;
  }
  return n;
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

// 閘門 3 兼任的 design 哨兵（DESIGN.md §5 閘門 3、§3 第 5b／7 點）。純讀檔，不是第六個閘門。
// 要抓的病：**「定稿記錄寫好了、畫面根本沒落地」曾經整輪放行過**——某輪 `_v2/` 只留一個空資料夾、
// 該輪連 design-frozen.json 都沒有，而 weave 舊條文只驗「有沒有定稿決議這筆檔」就放行，於是四個
// 子分頁改由 build 照決議散文重畫，與談好的稿差了 12 個區塊，八天後才被使用者走查抓到。
// 只在「grill-close 記著需要 UI」且「已經有定稿記錄」時才驗——還沒定稿的情況 weave 本來就會轉交 design，
// 在這裡叫只是重複。fail-open：任何解析異常一律不叫，不拖垮開場。
function buildDesignSentinel(base, root) {
  const close = readTextSafe(join(base, 'decisions', 'grill-close.md'));
  if (!close || !/是否需要\s*UI[^\n]*是（/.test(close)) return null; // 不需要 UI／沒有這個標記 → 不適用

  let names = [];
  try { names = readdirSync(join(base, 'decisions')).filter(f => f.toLowerCase().endsWith('.md')); } catch { return null; }
  const finalDoc = names.find(f => /design-final/i.test(f));
  if (!finalDoc) return null; // 還沒定稿——交給 weave 轉交 design，這裡不叫

  const problems = [];
  const frozenPath = join(base, 'design-frozen.json');
  if (!existsSync(frozenPath)) {
    problems.push('design-frozen.json 不存在 → 定稿沒有凍結，畫面很可能根本沒落地（就是上面那個病的樣態）');
  } else {
    try {
      const parsed = JSON.parse(readTextSafe(frozenPath) || '{}');
      const frozen = Array.isArray(parsed.frozen) ? parsed.frozen : [];
      if (frozen.length === 0) problems.push('design-frozen.json 的 frozen 是空陣列 → 沒有任何定稿檔案被鎖住');
      else {
        const missing = frozen.filter(p => typeof p === 'string' && !existsSync(join(root, p)));
        if (missing.length) {
          problems.push(`凍結名單有 ${missing.length} 個路徑在 repo 找不到：` +
            `${missing.slice(0, 3).join('、')}${missing.length > 3 ? '…' : ''}`);
        }
      }
      if (!parsed.source) problems.push('design-frozen.json 缺 source 欄（取稿座標）→ 日後走查會憑記憶找設計稿專案，曾因此找錯而誤判「稿不見了」');
    } catch { problems.push('design-frozen.json 解析失敗（JSON 壞了）'); }
  }
  if (!/逐區塊元件清單/.test(readTextSafe(join(base, 'decisions', finalDoc)) || '')) {
    problems.push(`定稿記錄 ${finalDoc} 沒有「逐區塊元件清單」→ 下游拆票只看得到區塊名字，區塊內部會整段蒸發且看不出來`);
  }
  if (!problems.length) return null;

  return ['⚠【design 定稿哨兵】這一輪記著需要 UI、也已經有定稿記錄，但下列項目不成立——依 DESIGN.md §3 第 5b／7 點，這代表 UI 其實還沒定稿完成（weave 進場的機器三驗會擋下）：',
    ...problems.map(p => `  · ${p}`),
    '  處置：Read skills/constellation/references/phase-design.md，補做步驟 5（直接改專案正式頁面 code）→ 5b（開本地 dev server 請使用者親自點過拍板）→ 7（定稿記錄附逐區塊清單、寫凍結名單與 source 欄）。'].join('\n');
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
  let map = null, ctx = null, dec = null, hist = null, designWarn = null;
  try { map = buildMapSection(base, root); } catch { /* fail-open */ }
  try { ctx = buildContextSection(base); } catch { /* fail-open */ }
  try { dec = buildDecisionsSection(base); } catch { /* fail-open */ }
  try { hist = buildHistorySection(base); } catch { /* fail-open */ }
  try { designWarn = buildDesignSentinel(base, root); } catch { /* fail-open */ }

  // 置頂強制讀檔指令：知識本體不在注入裡——放最前面，任何情況下最先被看到。
  if (map || ctx || dec) {
    const reads = [];
    // 地圖排第一：動手前最先要知道的是「東西在哪」，其次才是詞彙。
    if (map) reads.push(`.constellation/MAP.md（專案現況地圖，全文 ${map.lineCount} 行）`);
    if (ctx) reads.push(`.constellation/CONTEXT.md（專案詞彙與業務規則，全文 ${ctx.lineCount} 行）`);
    const parts = ['【開工前必讀】本專案知識軌不隨開場注入內文，下方只是座標。'];
    if (reads.length) {
      // 「只是查一下」那句是 2026-08-17 補的：原本只寫「動手任何工作前」，而純查詢型的開場
      // （使用者問「為什麼會這樣」）會被判定成不算動手而略過全文——但查問題查到一半就跑測試、
      // 連正式庫是常態，地圖的缺口／地雷區記的正是那些動作上的坑，且那一區不在注入內容裡。
      let sentence = `動手任何工作前先 Read：${reads.join('＋')}。` +
        '「只是回答問題／只是查一下」同樣要讀——查到一半就跑測試、連正式庫是常態';
      // 後半句只在真的有地圖時才講：沒有 MAP.md 的專案（例如工作流母本自己）提「地圖的地雷區」
      // 會指向一個不存在的東西，讀的人得花時間確認那是不是自己漏看了。
      if (map) {
        sentence += '，而地圖的「已知缺口與地雷」區記的正是那些動作上的坑，開場只注入模組索引、那一區不在裡面' +
          (map.hazardCount ? `（該區目前 ${map.hazardCount} 條）。` : '。');
      } else {
        sentence += '。';
      }
      parts.push(sentence);
    }
    // 決議改成「講查法」而不是列清單：開場看不到清單≠沒有那筆決議，這句是防止模型
    // 因為索引消失就自行推論「本專案沒相關決議」而繞過既有拍板。
    if (dec) {
      parts.push(`決議在 .constellation/decisions/，共 ${dec.count} 筆，編號越大越新；` +
        '要查特定主題請列目錄或用關鍵字搜尋（檔名與內文都搜），不要假設沒看到就不存在。');
    }
    lines.unshift(parts.join(''));
  }
  // design 哨兵緊跟票況：它講的是「這一輪的 UI 到底定稿了沒」，屬於現況而非知識軌，
  // 且不成立時會擋住 weave，所以要排在地圖與脈絡之前先被看到。
  if (designWarn) lines.push(designWarn);
  if (map) lines.push(map.text); // 票況之後、知識軌之前：先知道東西在哪，再談脈絡
  if (hist) lines.push(hist.text);
  if (dec) lines.push(dec.text);
  if (ctx) lines.push(ctx.text);
  lines.push(`驗證 runner：node "${VERIFY_RUNNER_ABS_PATH}"`);
  lines.push(`起停 server：node "${SERVE_ABS_PATH}" start|stop|list`);

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
