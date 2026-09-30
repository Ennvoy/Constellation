// gates/frozen-guard.mjs — 定稿 UI 凍結守衛的共用判定（閘門 5 的一項職責，DESIGN.md §3 第 7 點／§5）。
// 決議 030 從 close-gate.mjs 抽出：同一套「這個路徑在不在 design-frozen.json 的 frozen 名單」判斷，
// 兩個 hook 都呼叫——
//   - close-gate.mjs（PreToolUse Edit|Write|apply_patch）：checkFrozenPath(目標檔)。
//   - pre-tool-use.mjs（PreToolUse Bash|PowerShell）：frozenShellCheck(input)，從 shell 指令裡挑出
//     「會寫到哪些檔」再逐一 checkFrozenPath。原本 shell 這條路完全沒有凍結檢查，經 heredoc／sed／
//     Set-Content 寫檔可以無聲改掉定稿檔（AI_project_hub 決議 406 成因 A）。
// 本檔只能被 import、沒有 stdin 入口（close-gate.mjs 一載入就接 stdin，不能被別支 import，這是抽檔的原因）。
//
// shell 判斷是啟發式、不是完整的殼語法剖析（限制寫進 DESIGN.md §11）：只認常見寫檔形態——
// 重導向 > >> 2> &>、tee、sed/perl -i、Set-Content／Add-Content／Out-File／Clear-Content、
// cp／Copy-Item 的目的地、mv／Move-Item／Rename-Item／rm／Remove-Item（搬走或刪掉也算改動）、
// git checkout／restore／rm／mv 指到的路徑、dd of=；並追蹤同一條指令裡的 cd／Set-Location。
// 原則是「只擋明確命中」：挑出來的目標路徑必須真的解析到凍結名單裡的檔案才擋，唯讀指令（cat、grep、
// Get-Content、git diff、cp 的來源端）不挑目標、不會誤擋。認不出的寫法（node -e／python -c 腳本裡
// 寫檔、變數或萬用字元組出的路徑、git apply／stash／reset --hard 這類整批改動）照舊放行。
import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';

const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const BLOCK = msg => ({ block: true, message: msg });

export const DESIGN_FROZEN_REL = '.constellation/design-frozen.json';
export const DESIGN_FROZEN_PATH_RE = /(^|[\\/])\.constellation[\\/]design-frozen\.json$/i;

// 讀 .constellation 底下設定檔（design-frozen.json／design-baseline.json）時找 repo 根：從某個
// 起點目錄往上找，認 `.constellation` 目錄本身存在。
// 對抗審查 must-fix（P3 殘留）：舊寫法認 `.constellation/config.json`，但 config.json 要到 weave
// 階段才生成（DESIGN.md §4）、畫面定稿凍結卻發生在 design 階段（早於 weave）——新專案第一輪凍結
// design-frozen.json 時，往上找一路走到家目錄都找不到 config.json，退回錯誤的起點，導致合法的定稿
// 凍結被誤判成「baseline 不存在」而擋下，凍結守衛也會因為根算錯而讀錯位置、靜默 fail-open。改認
// `.constellation` 目錄本身（不要求 config.json），design/weave 兩階段都認得出來。
// 家目錄判斷順序很關鍵：**先**判斷是否已經走到家目錄、**再**檢查 `.constellation` 存不存在——
// 家目錄底下的 ~/.constellation/ 只放簽章 secret（不含 config.json，但目錄本身確實存在），順序反過來
// 會把家目錄誤判成專案根。找不到就回原起點（fail-open，維持「這層就是根」的舊行為，不誤擋）。
// 與 gates/verify-runner.mjs 的同名函式同一套邏輯，各自內聯一份，不共用 import——這是決議 023
// 否決「熱路徑小函式抽共用檔」那條的範圍，不屬於 P14 合一的 evidence.cjs（那支模組只管簽章驗證）。
export function findProjectRoot(from) {
  const home = resolve(homedir()).toLowerCase();
  let dir = resolve(from);
  for (;;) {
    if (dir.toLowerCase() === home) return resolve(from);
    if (existsSync(join(dir, '.constellation'))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(from);
    dir = up;
  }
}

// 路徑正規化：反斜線轉正斜線、解析成絕對路徑後去掉 root（repo 根）前綴變成 repo 相對路徑、統一小寫
// 做大小寫不敏感比對。frozen 名單裡的項目本來就是 repo 相對路徑，resolve(root, relPath) 會把它接到
// root 下再還原回同一個相對路徑，兩邊（目標檔案／名單項目）都走這條正規化才能公平比較。
export function normalizeRepoRelPath(filePath, root) {
  const rootAbs = resolve(root).replace(/\\/g, '/');
  const abs = resolve(root, String(filePath)).replace(/\\/g, '/');
  const rootLower = rootAbs.toLowerCase();
  const absLower = abs.toLowerCase();
  const rel = absLower.startsWith(rootLower + '/') ? abs.slice(rootAbs.length + 1) : abs;
  return rel.toLowerCase();
}

// 讀凍結名單：不存在／JSON 解析失敗／格式不對（frozen 不是陣列）一律回 null——呼叫端當作
// fail-open（跳過此檢查），不誤擋沒有用到定稿凍結機制的專案。root 是已經找過的專案根（見
// findProjectRoot），不是 hook 給的原始 cwd。
function readFrozenList(root) {
  try {
    const p = join(root, '.constellation', 'design-frozen.json');
    const data = JSON.parse(stripBom(readFileSync(p, 'utf8')));
    if (!data || !Array.isArray(data.frozen)) return null;
    return data.frozen.filter(f => typeof f === 'string' && f.length);
  } catch {
    return null;
  }
}

function frozenMessage(filePath, viaShell) {
  return [
    `Constellation 定稿 UI 凍結守衛：擋下——${filePath}${viaShell ? '（經 shell 指令寫入）' : ''}。`,
    '  → 此檔案是使用者定稿凍結的 UI 元件（design-frozen.json）——要修改必須先經使用者彈窗同意、將該檔' +
      '從 frozen 移除並在 log 記一筆 unfreeze（含原因），才能編輯。不得未經同意自行解凍。',
    ...(viaShell ? ['  → 改用 shell（重導向／Set-Content／sed -i／cp／git checkout 等）寫凍結檔同樣算編輯，不是繞道。'] : []),
  ].join('\n');
}

// 對抗審查 should-fix：巢狀 .constellation（例如 monorepo 子套件另外初始化過、但沒有
// design-frozen.json）時，findProjectRoot 認到的最近一層未必是凍結名單真正所在的根——逐層往上找
// 「真的有 design-frozen.json」的那一層，找不到才退回最近一層（維持原本 fail-open 行為，不誤擋
// 沒用到定稿凍結機制的專案）。
function findFrozenRoot(from) {
  const home = resolve(homedir()).toLowerCase();
  const fallback = findProjectRoot(from);
  let dir = resolve(from);
  for (;;) {
    if (dir.toLowerCase() === home) return fallback;
    if (existsSync(join(dir, '.constellation', 'design-frozen.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) return fallback;
    dir = up;
  }
}

// 給定單一目標檔案路徑（必須是絕對路徑），判斷是否命中凍結名單。回 BLOCK(...) 或 null（不擋）——
// 刻意不用 PASS 物件，因為 PASS 本身是 truthy，呼叫端要能用 `if (result)` 分辨「有擋下」與「沒事」。
// root 從目標檔所在目錄往上找，不用 hook 給的 cwd——cwd 可能是子目錄或另一個 worktree，會讀錯
// .constellation/design-frozen.json 的位置（見 P3）。
export function checkFrozenPath(filePath, viaShell = false) {
  // 例外：目標本身就是 design-frozen.json → 不受凍結檢查限制，否則永遠無法解凍。
  if (DESIGN_FROZEN_PATH_RE.test(String(filePath))) return null;
  const root = findFrozenRoot(dirname(String(filePath)));
  if (normalizeRepoRelPath(filePath, root) === DESIGN_FROZEN_REL) return null;

  const frozen = readFrozenList(root);
  if (!frozen || !frozen.length) return null; // 名單不存在／解析失敗／空清單 → fail-open

  const rel = normalizeRepoRelPath(filePath, root);
  const hit = frozen.some(f => normalizeRepoRelPath(f, root) === rel);
  return hit ? BLOCK(frozenMessage(filePath, viaShell)) : null;
}

// ─────────────────────────── shell 指令的寫檔目標 ───────────────────────────
// 粗篩：指令裡連一個寫檔形態的字樣都沒有，就不必切詞（pre-tool-use.mjs 用它決定要不要載入本檔）。
export const SHELL_WRITE_HINT_RE =
  />|\b(?:tee|sed|perl|cp|mv|rm|del|erase|rd|rmdir|unlink|truncate|shred|dd|sc|ac|ni|ri|mi|cpi|ren|rni|clc|copy|move|git)\b|-(?:content|item)\b|out-file/i;

// 切詞：尊重單雙引號；分隔符（; 換行 | || & && 以及詞首的括號／大括號）切成段；> >> 2> &> *> 記成
// 重導向、>&1 這類檔案描述子複製直接略過；< 的下一個詞是輸入來源，記成 '<' 讓後面丟掉。
function tokenize(cmd) {
  const out = [];
  let cur = null;
  const push = () => { if (cur !== null) { out.push({ w: cur }); cur = null; } };
  const n = cmd.length;
  for (let i = 0; i < n;) {
    const c = cmd[i];
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      const end = j < 0 ? n : j;
      cur = (cur ?? '') + cmd.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < n && cmd[j] !== '"') {
        if ((cmd[j] === '\\' || cmd[j] === '`') && cmd[j + 1] === '"') { s += '"'; j += 2; continue; }
        s += cmd[j++];
      }
      cur = (cur ?? '') + s;
      i = j + 1;
      continue;
    }
    if (c === '\n' || c === '\r' || c === ';' || c === '|' || c === '&') {
      if (c === '&' && cmd[i + 1] === '>') { cur = null; i++; continue; } // &> 檔案：交給下一輪的 '>'
      push(); out.push({ op: ';' });
      i += (c === '|' || c === '&') && cmd[i + 1] === c ? 2 : 1;
      continue;
    }
    // 括號／大括號只在詞首（或詞內括號已配平時的右括號）當分隔——`app/(internal)/x.tsx` 這種
    // 路徑裡的括號要留在詞內。
    if ((c === '(' || c === '{') && cur === null) { out.push({ op: ';' }); i++; continue; }
    if ((c === ')' || c === '}') && (cur === null || count(cur, c === ')' ? '(' : '{') <= count(cur, c))) {
      push(); out.push({ op: ';' }); i++; continue;
    }
    if (/\s/.test(c)) { push(); i++; continue; }
    if (c === '>') {
      if (cur !== null && /^(\d+|\*)$/.test(cur)) cur = null; else push();
      let j = i + 1;
      if (cmd[j] === '>' || cmd[j] === '|') j++;
      if (cmd[j] === '&') { j++; while (j < n && /[\d-]/.test(cmd[j])) j++; i = j; continue; } // >&1 複製描述子
      out.push({ op: '>' });
      i = j;
      continue;
    }
    if (c === '<') { push(); out.push({ op: '<' }); i++; continue; }
    cur = (cur ?? '') + c;
    i++;
  }
  push();
  return out;
}
const count = (s, ch) => s.split(ch).length - 1;

const cmdName = w => w.replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '');
const isFlag = w => /^-/.test(w);
const positional = ws => ws.filter(w => !isFlag(w));

// 參數整批都是寫入目標（除旗標外）：這些指令的「路徑參數」本身就是被改、被刪、被搬走的檔。
const ALL_ARGS_CMDS = new Set([
  'tee', 'set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content', 'clc',
  'remove-item', 'rm', 'ri', 'del', 'erase', 'rmdir', 'rd', 'unlink', 'truncate', 'shred',
  'move-item', 'mv', 'mi', 'move', 'rename-item', 'ren', 'rni', 'new-item', 'ni',
]);
const COPY_CMDS = new Set(['cp', 'copy', 'copy-item', 'cpi', 'install']);
const CD_CMDS = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location']);
const PREFIX_CMDS = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'builtin']);
// Copy-Item 帶值的具名參數：值是來源或篩選條件，不是目的地。
const COPY_VALUE_PARAMS = /^-(?:path|literalpath|filter|include|exclude|credential)$/i;

// 一段（已去掉重導向）的寫入目標；回傳 { targets: [{ p, base }], cd }。
function segmentTargets(words, cwd) {
  let ws = words.slice();
  while (ws.length && (PREFIX_CMDS.has(cmdName(ws[0])) || /^[A-Za-z_]\w*=/.test(ws[0]))) ws.shift();
  if (!ws.length) return { targets: [] };
  const name = cmdName(ws[0]);
  const args = ws.slice(1).map(w => w.replace(/^-\w+:(?=.)/, '')); // -Path:x → x
  const at = (p, base = cwd) => ({ p, base });

  if (CD_CMDS.has(name)) return { targets: [], cd: positional(args)[0] };
  if (ALL_ARGS_CMDS.has(name)) return { targets: positional(args).map(p => at(p)) };
  if ((name === 'sed' || name === 'perl') && args.some(w => /^-[a-zA-Z]*i|^--in-place/.test(w))) {
    return { targets: positional(args).map(p => at(p)) };
  }
  if (name === 'dd') return { targets: args.filter(w => /^of=/.test(w)).map(w => at(w.slice(3))) };
  if (COPY_CMDS.has(name)) {
    let dest = null, namedSrc = [];
    const pos = [];
    for (let i = 0; i < args.length; i++) {
      const w = args[i];
      if (/^-(?:destination|t)$/i.test(w)) { dest = args[++i] ?? null; continue; }
      if (/^--target-directory=/.test(w)) { dest = w.slice(w.indexOf('=') + 1); continue; }
      if (COPY_VALUE_PARAMS.test(w)) { if (args[i + 1] != null) namedSrc.push(args[++i]); continue; }
      if (!isFlag(w)) pos.push(w);
    }
    if (dest === null && (pos.length >= 2 || (namedSrc.length && pos.length >= 1))) dest = pos.pop();
    if (dest === null) return { targets: [] };
    const srcs = [...namedSrc, ...pos];
    const targets = [at(dest)];
    const destAbs = resolve(cwd, dest);
    let isDir = /[\\/]$/.test(dest);
    try { isDir = isDir || statSync(destAbs).isDirectory(); } catch {}
    if (isDir) for (const s of srcs) targets.push(at(join(dest, basename(s.replace(/[\\/]+$/, '')))));
    return { targets };
  }
  if (name === 'git') {
    let base = cwd, i = 0;
    for (; i < args.length; i++) {
      const w = args[i];
      if (w === '-C') { base = resolve(base, args[++i] ?? '.'); continue; }
      if (w === '-c') { i++; continue; }
      if (!isFlag(w)) break;
    }
    const sub = args[i];
    const rest = args.slice(i + 1);
    const pick = (valueFlags) => {
      const dd = rest.indexOf('--');
      if (dd >= 0) return rest.slice(dd + 1);
      const out = [];
      for (let k = 0; k < rest.length; k++) {
        if (valueFlags.test(rest[k])) { k++; continue; }
        if (!isFlag(rest[k])) out.push(rest[k]);
      }
      return out;
    };
    let paths = [];
    if (sub === 'checkout') paths = pick(/^-(?:b|B|-orphan)$/);
    else if (sub === 'restore') {
      const staged = rest.some(w => w === '--staged' || w === '-S');
      const worktree = rest.some(w => w === '--worktree' || w === '-W');
      if (!staged || worktree) paths = pick(/^-(?:s|-source)$/).filter(w => !/^--source=/.test(w));
    } else if (sub === 'rm') { if (!rest.includes('--cached')) paths = pick(/^$/); }
    else if (sub === 'mv') paths = pick(/^$/);
    return { targets: paths.map(p => at(p, base)) };
  }
  return { targets: [] };
}

// 可解析成固定路徑的詞才檢查：含變數（$）或萬用字元的詞無法靜態得知實際目標，照舊放行（限制）。
function resolveTarget(p, base) {
  if (!p || /[$*?]/.test(p)) return null;
  const expanded = p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
  return resolve(base, expanded);
}

// PreToolUse(Bash|PowerShell) 入口：命中凍結名單回 BLOCK，否則回 null。呼叫端負責 fail-open。
export function frozenShellCheck(input) {
  const ti = input.tool_input ?? input.toolInput ?? {};
  const cmd = String(ti.command ?? '');
  if (!cmd || !SHELL_WRITE_HINT_RE.test(cmd)) return null;
  let cwd = resolve(input.cwd ?? input.workspace_root ?? input.workingDirectory ?? process.cwd());

  const toks = tokenize(cmd);
  const segments = [[]];
  for (const t of toks) {
    if (t.op === ';') segments.push([]);
    else segments[segments.length - 1].push(t);
  }
  for (const seg of segments) {
    const words = [];
    const targets = [];
    for (let i = 0; i < seg.length; i++) {
      const t = seg[i];
      if (t.op === '>') { if (seg[i + 1]?.w != null) targets.push({ p: seg[++i].w, base: cwd }); continue; }
      if (t.op === '<') { if (seg[i + 1]?.w != null) i++; continue; }
      words.push(t.w);
    }
    const r = segmentTargets(words, cwd);
    targets.push(...r.targets);
    for (const { p, base } of targets) {
      const abs = resolveTarget(p, base);
      if (!abs) continue;
      const hit = checkFrozenPath(abs, true);
      if (hit) return hit;
    }
    if (r.cd) { const next = resolveTarget(r.cd, cwd); if (next) cwd = next; }
  }
  return null;
}
