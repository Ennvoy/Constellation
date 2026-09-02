#!/usr/bin/env node
// gates/serve.mjs — 臨時 server 的「記帳式起停」CLI（起、停、列、收）。
// 它是工具不是閘門：不擋任何動作、不掛 PreToolUse，只提供一組「起了就登記、收工照登記關」的指令。
//
// 要解決的問題：驗證／走查過程手動背景起的 server，流程被岔開就沒走到收尾，埠與進程留到下一輪；
// 殘留的舊 server 又會被 Playwright 的 reuseExistingServer 沿用（它只探測 URL 通不通、不驗是誰），
// 拿舊 build 蓋出合格證據——所以這是正確性問題，不只是效能問題。
// 作法：把「起」與「收」綁在同一支工具——start 起完就把 PID／埠／進程建立時間／session 寫進登記檔，
// stop 與 reap 只認登記檔，SessionEnd hook 呼叫 reap 兜底收掉本 session 起的。
//
// 設計鐵則（每一條都是為了「絕不誤殺」，寧可漏收也不能殺錯）：
//   1) 只殺自己這棵樹上的——用進程的親子鏈認人，不掃埠猜、不比對命令列。start 撞到埠被佔用一律
//      只回報不擊殺；stop 殺完後埠若還被別人佔著，也只回報不擊殺。
//   2) 殺前必比對進程建立時間，且「查不到建立時間」算比對失敗而非免驗——查不到就無從分辨 PID
//      有沒有被系統重新發出，此時放行等於閉著眼睛殺。
//   3) 登記的一定要是自己起的——start 等到埠通了還要確認綁埠的進程在自己這棵樹上，否則拒絕登記。
//   4) 登記檔 fail-safe——讀不到／壞掉當空，寫不進去只降級不擋主流程（同 .verify-state.json 規格）；
//      寫回前重讀，避免整份覆蓋掉平行 session 剛登記的那筆。
//   5) reap 一律 exit 0——SessionEnd hook 不得因為它出錯而失敗。
//
// 成本結構（本機實測，決定了 hook timeout 要開多大）：查進程建立時間只能走 WMI／CIM，而那要付
// PowerShell 冷啟——實測冷啟中位 5.5 秒（2.6–7.4）、全機快照中位 8.0 秒（5.7–16.8），netstat 只要
// 0.24 秒、taskkill 0.7 秒。因此：①所有外部呼叫都併成常數次、不隨台數增加（8 台實測 26 秒→9 秒）；
// ②本 session 沒有留下登記時（正常收工過的 session）完全不碰 PowerShell，reap 約 0.15 秒收工；
// ③SessionEnd 的 timeout 開 30 秒是為了容納「真的有 server 要收」時的最差值，不是常態耗時。
//
// 追蹤不到的情況（誠實揭露，不假裝清乾淨）：啟動指令若自己 detached 起背景進程（pm2、自寫 launcher）
// 且中介進程立刻退出，親子鏈就斷了，本工具追不到那顆孫進程——失敗路徑會照實說「沒清到」並要求人工確認。
//
// 登記檔 <專案根>/.constellation/.servers.json 與 log 目錄 <專案根>/.constellation/.servers/ 都是
// 「本機執行期狀態」：記的是本機 PID／埠，換一台機器讀到只會是誤導，故比照 .verify-state.json——
// 不進版控、不進 commit-gate 白名單、不進 clean-artifacts 清單。
//
// 用法：
//   node serve.mjs start --port <p> [--name <n>] [--wait <秒，預設 60>] -- <指令…>
//   node serve.mjs stop  --port <p> | --all
//   node serve.mjs list
//   node serve.mjs reap        （給 SessionEnd hook：從 stdin 讀 hook JSON，只收本 session 起的）
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 專案根與登記檔
// ---------------------------------------------------------------------------

// 從 from 往上找第一個含 .constellation/ 的目錄；找不到回 null。
function findRoot(from) {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, '.constellation'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const registryPath = root => path.join(root, '.constellation', '.servers.json');

function readRegistry(root) {
  try {
    const parsed = JSON.parse(stripBom(readFileSync(registryPath(root), 'utf8')));
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return [];
}

// 寫不進去回 false，由呼叫端降級提示；絕不丟例外中斷主流程。
function writeRegistry(root, list) {
  try {
    mkdirSync(path.dirname(registryPath(root)), { recursive: true });
    writeFileSync(registryPath(root), JSON.stringify(list, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

const entryKey = e => `${e.port}|${e.pid}|${e.startedAt}`;

// 從登記檔移除指定的幾筆。寫回前一定重讀：本輪處理可能跑了好幾秒，期間平行 session 若 start 了
// 新的一台，拿開頭的舊快照整份覆蓋會把它憑空抹掉，那台就此失去追蹤、變成沒人收得到的孤兒。
function dropFromRegistry(root, dropped) {
  if (!dropped.size) return true;
  const keys = new Set([...dropped].map(entryKey));
  return writeRegistry(root, readRegistry(root).filter(e => !keys.has(entryKey(e))));
}

// ---------------------------------------------------------------------------
// Windows 進程／埠查詢
// ---------------------------------------------------------------------------

// 埠 → LISTENING 的 PID 集合。netstat -ano 同時涵蓋 IPv4 與 IPv6（[::] 影子監聽）；
// 狀態欄在中文 Windows 仍輸出英文 LISTENING，只有表頭被在地化，故以 latin1 解碼避開
// 表頭的非 UTF-8 位元組（資料列全是 ASCII，不受影響）。
function listeners() {
  const map = new Map();
  let out = '';
  try {
    out = execFileSync('netstat', ['-ano'], {
      encoding: 'latin1',
      maxBuffer: 1 << 24,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return map;
  }
  for (const line of out.split(/\r?\n/)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 5 || c[3] !== 'LISTENING') continue;
    const port = Number(c[1].slice(c[1].lastIndexOf(':') + 1));
    const pid = Number(c[4]);
    if (!port || !Number.isInteger(pid)) continue;
    if (!map.has(port)) map.set(port, new Set());
    map.get(port).add(pid);
  }
  return map;
}

const ownersOf = (port, snap) => [...((snap || listeners()).get(Number(port)) || [])];

const powershell = script =>
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] },
  );

// 全機進程快照：PID → { ppid, creationDate（原樣字串）, born（毫秒） }。
// 只取這三個欄位——帶上 CommandLine 會慢好幾倍，而認親只需要親子鏈與出生時間。
// 任何失敗回空 map，由呼叫端當「查不到」處理（＝比對失敗＝不動手）。
function procSnapshot() {
  const map = new Map();
  const script =
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ` +
    `$r=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ` +
    `Select-Object ProcessId,ParentProcessId,@{n='C';e={$_.CreationDate.ToString('o')}}); ` +
    `ConvertTo-Json -InputObject $r -Compress -Depth 3`;
  try {
    for (const p of JSON.parse(powershell(script) || '[]')) {
      const creationDate = String(p.C || '');
      map.set(Number(p.ProcessId), {
        ppid: Number(p.ParentProcessId),
        creationDate,
        born: Date.parse(creationDate) || 0,
      });
    }
  } catch {}
  return map;
}

// 一次 PowerShell 查指定幾個 PID 的建立時間與命令列（要顯示「那是什麼進程」時才用）。
function procInfo(pids) {
  const map = new Map();
  const uniq = [...new Set(pids.map(Number).filter(p => Number.isInteger(p) && p > 0))];
  if (!uniq.length) return map;
  const filter = uniq.map(p => `ProcessId=${p}`).join(' OR ');
  const script =
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ` +
    `$r=@(Get-CimInstance Win32_Process -Filter '${filter}' -ErrorAction SilentlyContinue | ` +
    `Select-Object ProcessId,@{n='CreationDate';e={$_.CreationDate.ToString('o')}},CommandLine); ` +
    `ConvertTo-Json -InputObject $r -Compress -Depth 3`;
  try {
    for (const p of JSON.parse(powershell(script) || '[]')) {
      map.set(Number(p.ProcessId), {
        creationDate: String(p.CreationDate || ''),
        cmd: String(p.CommandLine || '').replace(/\s+/g, ' ').trim(),
      });
    }
  } catch {}
  return map;
}

// rootPid 這棵樹上還活著的後代（不含 rootPid 自己）。
// since：這棵樹誕生的時間戳（毫秒）——鏈上每一跳都必須晚於它，否則就是 PID 被系統重新發出後
// 接出來的假親子關係（cmd.exe 這種短命進程的 PID 極易被重發）。
// 呼叫端必須先確認 rootPid 值得信任：本進程幾秒前才 spawn 的，或建立時間比對通過的。
// until：後代誕生時間的上界，只有在 rootPid 已經死掉、必須靠登記的時間戳夾出安全區間時才給。
function descendantsOf(rootPid, since, snap, until = Infinity) {
  const root = Number(rootPid);
  const out = [];
  for (const [pid, p] of snap) {
    if (pid === root) continue;
    let cur = p;
    for (let hop = 0; cur && hop < 12; hop++) {
      if (cur.born < since || cur.born > until) break; // 落在這棵樹的誕生區間外，不可能是它的後代
      if (cur.ppid === root) { out.push(pid); break; }
      const parent = snap.get(cur.ppid);
      if (!parent || parent.born > cur.born) break; // 父比子晚生 → 鏈是 PID 回收接出來的，不算
      cur = parent;
    }
  }
  return out;
}

// 從 pid 往上追到 rootPid，回傳中間夾著的那幾層（不含 pid 與 rootPid 本身）；追不到就整條作廢回空陣列。
// 用途：外殼 cmd.exe 常在 start 記帳完就退出，只剩「套件管理器 → server」半截鏈掛在那裡；
// 從已驗明正身的綁埠 PID 往上追，才收得到那截中間層。
// 防 PID 回收：每一跳都要求父進程的建立時間落在 [外殼誕生, 子進程誕生] 之間——PID 被系統重新
// 發出後的新進程必然生得比子進程晚，這道區間檢查直接把假鏈擋掉。
function ancestorsUpTo(pid, rootPid, lowerBound, snap) {
  const root = Number(rootPid);
  const out = [];
  let cur = snap.get(Number(pid));
  for (let hop = 0; cur && hop < 12; hop++) {
    if (cur.ppid === root) return out; // 追到外殼，這條鏈成立
    const parent = snap.get(cur.ppid);
    if (!parent || parent.born < lowerBound || parent.born > cur.born) return [];
    out.push(cur.ppid);
    cur = parent;
  }
  return [];
}

// 殺整棵進程樹：/T 連子孫一起、/F 強制。taskkill 可以一次帶多個 /PID，
// 併成一次呼叫只付一次進程冷啟（SessionEnd 有 timeout，收多台時省下來的是實打實的秒數）。
function killTree(pids) {
  const list = [...new Set([pids].flat().map(Number).filter(p => Number.isInteger(p) && p > 0))];
  if (!list.length) return;
  try {
    execFileSync('taskkill', [...list.flatMap(p => ['/PID', String(p)]), '/T', '/F'], { stdio: 'ignore' });
  } catch {}
}

// 進程是否還在。EPERM＝存在但沒權限查，一樣算還在。
function alive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// 共用小工具
// ---------------------------------------------------------------------------
const brief = s => {
  const t = String(s || '').trim();
  return !t ? '命令列查不到（系統進程或權限不足）' : t.length > 110 ? t.slice(0, 110) + '…' : t;
};
const safeName = n => String(n).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'server';

function tailFile(p, n) {
  try {
    return readFileSync(p, 'utf8').split(/\r?\n/).slice(-n).join('\n');
  } catch {
    return '(讀不到 log)';
  }
}

// 建立時間比對：兩邊都要有值、且完全相符才算通過。
// 缺任一邊算「比對失敗」而不是「免驗」——查不到建立時間時無從分辨 PID 有沒有被回收，
// 放行等於閉著眼睛殺（外殼 cmd.exe 在 start 抓建立時間前就退出是常態，此欄空掉並不罕見）。
const sameBirth = (recorded, actual) => Boolean(recorded && actual && recorded === actual);
const shown = v => (v ? v : '（查不到）');

// 登記裡有沒有任何進程還活著。alive() 是零成本的系統呼叫，用它先擋一道，免得在「其實沒東西
// 要處理」時白白付一次 PowerShell 冷啟——本機實測冷啟中位 5.5 秒（區間 2.6–7.4），全機快照
// 中位 8.0 秒（區間 5.7–16.8）。注意它只看綁埠 PID 與外殼，看不到中間層，故僅用於「要不要查
// 快照來顯示狀態」這種漏判無害的地方；判死活要動手殺或刪登記時一律走 resolveTargets 的樹判定。
const anyAlive = entries => entries.some(e => alive(e.pid) || (e.shellPid && alive(e.shellPid)));

// session id：Bash／PowerShell 工具起的子進程本身就拿得到 runtime 注入的環境變數，
// 不必靠 hook stdin。拿不到就記 unknown（那筆之後只能靠明確 stop 或 stop --all 收）。
const envSession = () => process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_SESSION_ID || 'unknown';

// ---------------------------------------------------------------------------
// 依登記關掉一批 server
// ---------------------------------------------------------------------------
// 算出這筆登記「可以安全擊殺哪些 PID」，比對不過的理由順手印出來。
// snap 由呼叫端一次查好整批傳入，避免每筆各跑一次全機掃描。
function resolveTargets(e, snap) {
  const label = `${e.name}（port ${e.port}）`;
  const hasShell = Boolean(e.shellPid) && Number(e.shellPid) !== Number(e.pid);
  const shell = hasShell ? snap.get(Number(e.shellPid)) : null;
  const cur = snap.get(Number(e.pid));

  // ours：確認屬於這棵樹、可以動手殺的 PID。只有建立時間比對通過的才進得來。
  const ours = new Set();

  // 外殼樹：只殺綁埠 PID 會留下空轉的 cmd→套件管理器 上游鏈，所以連後代一起收；
  // 但要先確認外殼還是當初那個進程，比對不過就整棵不碰。
  const shellBorn = Date.parse(e.shellCreationDate || '') || 0;
  const pidBorn = Date.parse(e.creationDate || '') || 0;
  // PID 已經不是當初那個：不存在，或存在但建立時間對不上（＝已被系統回收、換了別的進程）。
  // 不能只看「不存在」——PID 回收後現在這個活著的陌生進程一樣要判定成「不是當初那個」。
  const pidGone = !cur || !sameBirth(e.creationDate, cur.creationDate);
  if (shell) {
    if (sameBirth(e.shellCreationDate, shell.creationDate)) {
      ours.add(Number(e.shellPid));
      for (const p of descendantsOf(e.shellPid, shell.born, snap)) ours.add(p);
    } else {
      console.log(
        `⚠ ${label}：外殼 PID ${e.shellPid} 的建立時間比對不過（登記 ${shown(e.shellCreationDate)}／` +
          `現況 ${shown(shell.creationDate)}），判定不是當初那個進程，不動它。`,
      );
    }
  } else if (hasShell && shellBorn && pidBorn && pidGone) {
    // 外殼不在了，且綁埠 PID 也不在了或已被回收（pidGone），但中間層可能還掛著（server 被單獨
    // 殺掉、上游套件管理器還在重試）。此時沒有可信的活進程可比對，改用登記留下的兩個時間戳夾出
    // 安全區間：後代必須生在「外殼誕生」與「綁埠 PID 誕生」之間——PID 被回收後接出來的新進程
    // 一定晚於這個區間。
    for (const p of descendantsOf(e.shellPid, shellBorn, snap, pidBorn)) ours.add(p);
  }

  // 綁埠的主 PID：同樣要比對建立時間；/T 會一併帶走它自己的子孫。
  if (cur) {
    if (sameBirth(e.creationDate, cur.creationDate)) {
      ours.add(Number(e.pid));
      // 外殼多半已經退出（實測 cmd.exe 在 start 記帳完就不見了），只殺綁埠 PID 會留下
      // 「套件管理器」那截空轉的中間層，所以從已驗明正身的綁埠 PID 往上補收到外殼為止。
      if (shellBorn) for (const p of ancestorsUpTo(e.pid, e.shellPid, shellBorn, snap)) ours.add(p);
    } else {
      console.log(
        `⚠ ${label}：PID ${e.pid} 的建立時間比對不過（登記 ${shown(e.creationDate)}／現況 ${shown(cur.creationDate)}），` +
          `判定 PID 已被回收、現在跑的是別的進程，拒絕擊殺。`,
      );
    }
  }

  return ours;
}

// 收完之後照實回報這一筆的下場。ports 是「殺完後」的埠快照，strangerInfo 是批次一次查好的命令列。
function reportEntry(e, ours, ports, strangerInfo) {
  const label = `${e.name}（port ${e.port}）`;
  if (!ours.size) {
    console.log(`· ${label}：沒有可安全擊殺的進程（登記的 PID 已不存在或已被回收），移除登記。`);
    return;
  }
  const survived = [...ours].filter(alive);
  const owners = ownersOf(e.port, ports);
  const strangers = owners.filter(p => !ours.has(Number(p)));
  const killedText = [...ours].filter(p => !survived.includes(p)).join('、') || '無';
  if (!owners.length && !survived.length) {
    console.log(`✓ 已關閉 ${label}：擊殺 PID ${killedText}，埠已釋放。`);
    return;
  }
  console.log(`⚠ ${label}：已擊殺 PID ${killedText}。`);
  if (survived.length) console.log(`    這些 PID 殺不掉（權限不足？）：${survived.join('、')}`);
  for (const p of strangers) {
    console.log(`    port ${e.port} 目前被 PID ${p}（${brief(strangerInfo.get(Number(p))?.cmd)}）佔用——不在本工具這棵樹上，未擊殺。`);
  }
}

// 一次收掉一批登記：殺掉還活著的、並把這批全部移出登記檔（整棵樹都死的那筆自然是「沒有可
// 安全擊殺的進程」，一樣移除登記）。
// 所有外部進程呼叫（全機快照、netstat、taskkill）都併成常數次、不隨台數增加：
// SessionEnd 有 timeout，逐台各跑一輪 netstat 會直接撞上限、收到一半被砍斷。
function shutdownBatch(root, targets) {
  const snap = procSnapshot();
  const plans = targets.map(e => ({ e, ours: resolveTargets(e, snap) }));
  killTree(plans.flatMap(p => [...p.ours]));

  // 補刀只補自己人：埠還被佔著時，只有 owner 就在自己這棵樹上才再殺一次。
  // 掃埠猜哪個該死正是決議 020 否決的作法——那會殺掉使用者自己正開著看的畫面。
  let ports = listeners();
  const again = plans.flatMap(p => ownersOf(p.e.port, ports).filter(x => p.ours.has(Number(x))));
  if (again.length) {
    killTree(again);
    ports = listeners();
  }

  // ours 為空的那幾筆，reportEntry 會在 `!ours.size` 就 early return、strangerInfo 根本不會被印出來，
  // 這裡先排掉可省一次白付的 procInfo（PowerShell 冷啟）。
  const strangers = plans.flatMap(p => (p.ours.size ? ownersOf(p.e.port, ports).filter(x => !p.ours.has(Number(x))) : []));
  const strangerInfo = strangers.length ? procInfo(strangers) : new Map();
  for (const { e, ours } of plans) reportEntry(e, ours, ports, strangerInfo);

  if (!dropFromRegistry(root, new Set(targets))) {
    console.log(`⚠ 登記檔寫不進去（${registryPath(root)}），下次 list 可能還會看到已關掉的項目。`);
  }
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------
async function cmdStart(root, opts, rest) {
  const port = Number(val(opts, '--port'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('start 需要 --port <1-65535>。');
    return 1;
  }
  if (!rest.length) {
    console.error('start 需要在 -- 後面接要執行的指令，例如：start --port 48800 -- pnpm dev');
    return 1;
  }
  const command = rest.join(' ');
  const name = safeName(val(opts, '--name') || `port-${port}`);
  const wait = Math.max(1, Number(val(opts, '--wait', '60')) || 60);

  // 起前先看埠有沒有殘留：有就只回報、不擊殺（可能是使用者自己開的）。
  const occupied = ownersOf(port);
  if (occupied.length) {
    const info = procInfo(occupied);
    for (const p of occupied) {
      console.error(
        `埠 ${port} 已被 PID ${p}（${brief(info.get(p)?.cmd)}）佔用；` +
          `若是上一輪殘留請先 node "${SELF}" stop --port ${port}`,
      );
    }
    console.error('本工具只關自己登記的 server，不會自動擊殺這個進程。');
    return 1;
  }

  const logDir = path.join(root, '.constellation', '.servers');
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${name}.log`);
  const fd = openSync(logPath, 'a');
  // 注意：Windows 上 detached:true 與 shell:true 不能併用——detached 讓 cmd.exe 以
  // DETACHED_PROCESS 起，它會重接自己的標準輸出，繼承進來的 log fd 與它自己做的 `> 檔案`
  // 重導雙雙失效（實測：三種寫法都留下 0 位元組的 log）。而 detached 本來要換的「父進程走了
  // 子進程還在」，不 detached 也成立（Windows 沒有父死連坐；實測跨 tool call 仍在監聽），
  // 故一律不 detached，換回可用的 log——沒有 log 就沒有「起不來時看得到原因」。
  const spawnedAt = Date.now();
  const child = spawn(command, {
    cwd: process.cwd(),
    shell: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  child.unref();
  child.on('error', () => {});
  let exitedAt = 0;
  child.on('exit', () => { exitedAt = Date.now(); });
  const shellPid = child.pid;

  // 輪詢等埠進入 LISTENING。外殼提早退出時多給 5 秒寬限就放棄——
  // `start /b` 這類寫法外殼本來就會先退，所以不能一看到退出就當失敗。
  const deadline = Date.now() + wait * 1000;
  let bound = [];
  while (Date.now() < deadline) {
    bound = ownersOf(port);
    if (bound.length) break;
    if (exitedAt && Date.now() - exitedAt > 5000) break;
    await sleep(300);
  }

  // 埠通了還不夠，要確認綁埠的進程真的在自己這棵樹上。只問「埠通了沒」的話，等待期間
  // 使用者自己在同一個埠開的 server 會被登記成我們的，之後 stop 就會殺掉使用者的東西
  // ——而且建立時間比對必然通過（登記的就是它本人），兩道防護一起失效。
  // shellPid 是本進程幾秒前才 spawn 的，PID 在這麼短的時間內被回收的機率可忽略，故直接當根。
  const snap = procSnapshot();
  const mine = new Set([Number(shellPid), ...descendantsOf(shellPid, spawnedAt, snap)]);
  const pid = bound.map(Number).find(p => mine.has(p));

  if (!pid) {
    // 失敗路徑：清掉自己這棵樹，並照實說明清到什麼程度——謊報清乾淨會讓孤兒沒人再去看。
    const mySurvivors = [...mine].filter(alive);
    killTree(mySurvivors);
    const killed = mySurvivors.filter(p => !alive(p));
    const stuck = mySurvivors.filter(p => alive(p));

    if (bound.length) {
      const info = procInfo(bound);
      console.error(
        `等待期間 port ${port} 被 PID ${bound.join('、')}（${brief(info.get(Number(bound[0]))?.cmd)}）綁走，` +
          `不在本工具這棵樹上（親子鏈對不上），未擊殺它，也不登記。`,
      );
    } else {
      console.error(
        `等不到 port ${port} 進入 LISTENING（上限 ${wait} 秒${exitedAt ? '；啟動指令的外殼已提早退出' : ''}）。`,
      );
    }
    console.error(
      killed.length
        ? `已擊殺自己起的進程：PID ${killed.join('、')}。`
        : `沒有找到還活著的自家進程可清（外殼 PID ${shellPid} 與其後代都已不存在）。`,
    );
    if (stuck.length) console.error(`這些自家 PID 殺不掉（權限不足？）：${stuck.join('、')}`);
    console.error(
      `若啟動指令自己 detached 起了背景進程（pm2、自寫 launcher），中介進程一退出親子鏈就斷了、` +
        `本工具追不到，請 netstat -ano | findstr :${port} 自行確認有無殘留。`,
    );
    console.error(`log 尾 30 行（${logPath}）：`);
    console.error(tailFile(logPath, 30));
    return 1;
  }

  const entry = {
    name,
    port,
    pid,
    creationDate: snap.get(pid)?.creationDate || '',
    shellPid,
    shellCreationDate: snap.get(Number(shellPid))?.creationDate || '',
    cmd: command,
    logPath,
    startedBy: envSession(),
    startedAt: new Date().toISOString(),
  };
  const list = readRegistry(root).filter(e => Number(e.port) !== port); // 同一埠只留最新一筆
  list.push(entry);
  const saved = writeRegistry(root, list);

  console.log(`✓ 已起 ${name}：http://localhost:${port}`);
  console.log(`  PID ${pid}（綁埠）／外殼 PID ${shellPid}`);
  if (bound.length > 1) console.log(`  注意：這個埠有多個 LISTENING owner（${bound.join('、')}），登記的是 ${pid}。`);
  console.log(`  log：${logPath}`);
  console.log(`  收工：node "${SELF}" stop --port ${port}`);
  if (!entry.creationDate) {
    console.log('⚠ 查不到這個 PID 的建立時間：stop 時建立時間比對會失敗（防 PID 回收），屆時只會移除登記、不會擊殺，請自行確認埠有沒有釋放。');
  }
  if (!saved) {
    console.log(`⚠ 登記檔寫不進去（${registryPath(root)}）：這台不會被 stop --all／SessionEnd 自動收，請記得手動 stop。`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// stop / list / reap
// ---------------------------------------------------------------------------
function cmdStop(root, opts) {
  const all = opts.includes('--all');
  const port = Number(val(opts, '--port'));
  if (!all && !Number.isInteger(port)) {
    console.error('stop 需要 --port <p> 或 --all。');
    return 1;
  }
  const list = readRegistry(root);
  const targets = all ? list.slice() : list.filter(e => Number(e.port) === port);
  if (!targets.length) {
    console.log(all ? '登記檔沒有任何 server，無事可做。' : `登記檔裡沒有 port ${port} 的紀錄。`);
    if (!all) {
      const owners = ownersOf(port);
      if (owners.length) {
        console.log(`（但 port ${port} 目前被 PID ${owners.join('、')} 佔用——不是本工具起的，不予處理。）`);
      }
    }
    return 0;
  }
  // 注意 stop 一律走完整流程（含全機快照），不用 anyAlive 抄捷徑：綁埠 PID 與外殼都死了、
  // 中間那層套件管理器還掛著的情況只能靠快照追出來。stop 是明確下的收工指令、沒有 timeout，
  // 付得起這個錢；要抄捷徑的是有 timeout 的 reap。
  // --all 收的是「登記檔裡的全部」，含平行 session 起的。先講明白，免得誤傷還在用的畫面。
  if (all) {
    const sid = envSession();
    const others = targets.filter(e => e.startedBy !== sid);
    if (others.length) {
      console.log(`注意：這 ${targets.length} 筆裡有 ${others.length} 筆是別的 session 起的（${others.map(e => `port ${e.port}`).join('、')}），一併收掉。`);
      console.log('只收自己這一台請改用 stop --port <p>。');
    }
  }
  shutdownBatch(root, targets);
  return 0;
}

function cmdList(root) {
  const list = readRegistry(root);
  if (!list.length) {
    console.log('登記檔沒有任何 server。');
    return 0;
  }
  const ports = listeners();
  const snap = anyAlive(list) ? procSnapshot() : new Map();
  console.log(`登記檔：${registryPath(root)}（${list.length} 筆）`);
  for (const e of list) {
    const cur = snap.get(Number(e.pid));
    const state = !cur
      ? '已死'
      : sameBirth(e.creationDate, cur.creationDate)
        ? '存活'
        : 'PID 已被回收（現在是別的進程，stop 不會動它）';
    const owners = ownersOf(e.port, ports);
    const ownerText = owners.length
      ? owners.map(p => (Number(p) === Number(e.pid) ? `${p}（就是它）` : `${p}（別人）`)).join('、')
      : '無人監聽';
    console.log(`· ${e.name}  port ${e.port}  PID ${e.pid}  ${state}`);
    console.log(`    埠目前 owner：${ownerText}`);
    console.log(`    起於 ${e.startedAt}　session ${e.startedBy}`);
    console.log(`    指令 ${brief(e.cmd)}`);
    console.log(`    log ${e.logPath}`);
  }
  return 0;
}

// 給 SessionEnd hook 用：只碰 startedBy 等於本 session 的登記，別的 session 那幾筆一個都不動
// （不殺、也不刪）——刪掉別人的登記等於把那台的殘骸變成永久沒人收得到的孤兒。
// 一律 exit 0——SessionEnd 沒有決策權、也不該讓 session 結束流程出錯。
async function cmdReap() {
  let payload = {};
  try {
    payload = JSON.parse(stripBom(await readStdin())) || {};
  } catch {}
  const str = v => (typeof v === 'string' && v ? v : '');
  const sid = str(payload.session_id);
  // cwd 的鍵名各 runtime 不一，比照 session-start.mjs 做三鍵 fallback。
  const root = findRoot(str(payload.cwd) || str(payload.workspace_root) || str(payload.workingDirectory) || process.cwd());
  if (!root) return;
  const list = readRegistry(root);
  if (!list.length) return;

  // 認不出本 session 時什麼都不做：全收會殺到平行 session 正在用的 server（決議 020 的否決
  // 清單第一條就是「平行 session 互殺」），連刪登記都不行——登記一刪，那台就再也沒人收得到。
  if (!sid) {
    console.error('serve.mjs reap：hook stdin 沒有 session_id，本輪不收也不刪任何登記。');
    return;
  }
  const targets = list.filter(e => e.startedBy === sid);
  // 本 session 沒留下任何登記（正常收工過的 session 就是這樣）就零成本退場，不付全機快照的冷啟稅。
  if (!targets.length) return;

  // 有本 session 的登記就走 stop 同款的完整流程：死活一律由 resolveTargets 的樹判定說了算。
  // 不能用 alive(e.pid) 一個欄位抄捷徑——「綁埠 PID 已死、中間層還掛著」的殘骸會被判成死透、
  // 登記被刪掉，殘骸從此永久無人可收；那截中間層只有全機快照沿親子鏈才追得出來。
  shutdownBatch(root, targets);
}

function readStdin(ms = 3000) {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise(resolve => {
    let data = '';
    const done = () => { clearTimeout(timer); resolve(data); };
    const timer = setTimeout(() => resolve(data), ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const val = (argv, n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

const USAGE = [
  'Constellation 臨時 server 記帳式起停',
  `  node "${SELF}" start --port <p> [--name <n>] [--wait <秒，預設 60>] -- <指令…>`,
  `  node "${SELF}" stop  --port <p>    （收自己這一台）`,
  `  node "${SELF}" stop  --all         （收登記檔裡的全部，含別的 session 起的）`,
  `  node "${SELF}" list`,
  `  node "${SELF}" reap        （SessionEnd hook 用，從 stdin 讀 hook JSON）`,
].join('\n');

const argv = process.argv.slice(2);
const sub = argv[0];
const sepIdx = argv.indexOf('--');
const opts = sepIdx >= 0 ? argv.slice(1, sepIdx) : argv.slice(1);
const rest = sepIdx >= 0 ? argv.slice(sepIdx + 1) : [];

if (sub === 'reap') {
  // reap 全程吞例外：SessionEnd 不能因為它而失敗。
  try {
    await cmdReap();
  } catch (err) {
    console.error(`serve.mjs reap 例外（已忽略）：${err?.message || err}`);
  }
  process.exit(0);
} else if (sub === 'start' || sub === 'stop' || sub === 'list') {
  const root = findRoot(process.cwd());
  if (!root) {
    console.error(`從 ${process.cwd()} 往上找不到含 .constellation/ 的專案根，無處記帳。`);
    process.exit(1);
  }
  const code =
    sub === 'start' ? await cmdStart(root, opts, rest) : sub === 'stop' ? cmdStop(root, opts) : cmdList(root);
  process.exit(code);
} else {
  console.error(USAGE);
  process.exit(sub ? 1 : 0);
}
