// gates/test/kill-guard.test.mjs — 殺行程守門黑箱測試。
// killGuardCheck 是純函式（gates/kill-guard.mjs 沒有任何自動執行的入口，homedir() 特意延後到
// 呼叫當下才取值），直接 import 呼叫即可，不必為這支閘門另外 spawn 子行程去跑 pre-tool-use.mjs
// （dispatcher 整合驗證留給 pre-tool-use.test.mjs）。
//
// 安全規則：全程把 USERPROFILE／HOME 指到本檔自建的拋棄式假家目錄，holder.json 只寫在假目錄
// 底下，絕不碰真正的 ~/.constellation/leases（出貨鎖從決議 033 起每個專案一把：leases/<專案鍵>/holder.json，
// 守門讀全部專案的登記取聯集，舊版 leases/machine 當成其中一份）；「持有方」一律用本檔自己 spawn 的 sleeper 行程
// 的真實 PID 模擬，killGuardCheck 本身是純判定函式、不會 shell out，本檔從頭到尾不會真的執行
// 任何一句 taskkill／Stop-Process／kill。
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { killGuardCheck } from '../kill-guard.mjs';
import { projectKey } from '../lease.mjs';

const bash = (command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, ...extra });
const DEFAULT_KEY = 'k-crm'; // 預設登記（crm-system 專案那一份）的目錄名

let fakeHome, holderFile, leasesDir, projBase, projCrm, origUserProfile, origHome;
let holderProc, childProc; // 測試自己 spawn 的假行程，模擬持有方——絕不用機器上真實的其他行程
let holder2Proc, child2Proc; // 第二個專案的持有方（多專案案例用）
const holderFileOf = key => join(leasesDir, key, 'holder.json');
// 真的建出專案目錄（有 .constellation 與 .git），專案鍵才算得穩——不能用不存在的路徑，往上找專案根
// 會一路走到真實家目錄底下的 .constellation 去。
function makeProject(name) {
  const dir = join(projBase, name);
  mkdirSync(join(dir, '.constellation'), { recursive: true });
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

before(() => {
  origUserProfile = process.env.USERPROFILE;
  origHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'kg-home-'));
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  leasesDir = join(fakeHome, '.constellation', 'leases');
  holderFile = holderFileOf(DEFAULT_KEY);
  mkdirSync(dirname(holderFile), { recursive: true });
  projBase = mkdtempSync(join(tmpdir(), 'kg-proj-'));
  projCrm = makeProject('crm-system');

  // 幾個無害的 sleeper 行程只用來提供真實 PID；.pid 在 spawn() 呼叫後就同步可用，不必等它們
  // 真的跑起來——killGuardCheck 只用 isPidAlive 判存活，行程活著就夠了。
  const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 300000)']);
  holderProc = sleeper();
  childProc = sleeper();
  holder2Proc = sleeper();
  child2Proc = sleeper();
});

after(() => {
  for (const p of [holderProc, childProc, holder2Proc, child2Proc]) { try { p.kill(); } catch {} }
  if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile;
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  try { rmSync(projBase, { recursive: true, force: true }); } catch {}
});

// 欄位名稱與 gates/lease.mjs／verify-runner.mjs 的 acquireShipLease 實際寫入的 holder.json 一致：
// root、session、runtime、pid、startedAt、purpose、estimatedEndAt、shellPid。
// key 參數是登記所在的目錄名（隨便取）；登記裡的 key 欄位照 runner 的寫法放 root 算出的專案鍵，
// 覆寫成 undefined 就是舊版（決議 026）沒有 key 欄位的格式。
function writeHolder(overrides = {}, key = DEFAULT_KEY) {
  const holder = {
    root: projCrm,
    session: 'other-session',
    runtime: 'claude',
    pid: holderProc.pid,
    startedAt: new Date(2026, 8, 25, 2, 18).getTime(), // 09-25 02:18（本機時區）
    purpose: 'ship 全量驗證',
    estimatedEndAt: null,
    shellPid: childProc.pid,
    ...overrides,
  };
  if (!('key' in overrides)) holder.key = projectKey(holder.root);
  mkdirSync(dirname(holderFileOf(key)), { recursive: true });
  writeFileSync(holderFileOf(key), JSON.stringify(holder));
  return holder;
}
function clearHolder() {
  try { unlinkSync(holderFile); } catch {}
}
function clearAllHolders() {
  try { rmSync(leasesDir, { recursive: true, force: true }); } catch {}
}

function assertBlocked(input, label) {
  const r = killGuardCheck(input);
  assert.equal(r.block, true, `${label}：應擋下，實際 ${JSON.stringify(r)}`);
  return r;
}
function assertPassed(input, label) {
  const r = killGuardCheck(input);
  assert.equal(r.block, false, `${label}：應放行，實際 ${JSON.stringify(r)}`);
}

describe('kill-guard：沒人持有出貨鎖', () => {
  before(() => clearHolder());
  test('taskkill 任意 PID 都放行', () => assertPassed(bash('taskkill /PID 99999 /F'), '無持有者'));
  test('holder.json 壞掉（非法 JSON）也放行（fail-open）', () => {
    mkdirSync(dirname(holderFile), { recursive: true });
    writeFileSync(holderFile, '{not json');
    assertPassed(bash('taskkill /PID 1234 /F'), 'holder.json 壞掉');
    clearHolder();
  });
  test('input 本身壞掉（null）也 fail-open 放行', () => {
    assert.equal(killGuardCheck(null).block, false);
  });
});

describe('kill-guard：擋其他 session 持有者的 PID', () => {
  before(() => writeHolder());
  after(() => clearHolder());

  test('Windows cmd /PID 命中 runner pid', () =>
    assertBlocked(bash(`taskkill /PID ${holderProc.pid} /F`), 'taskkill /PID'));

  test('Git Bash //PID 命中 runner pid', () =>
    assertBlocked(bash(`taskkill //PID ${holderProc.pid} //F`), 'taskkill //PID'));

  test('一次多個 PID（//PID 重複出現），其中一個命中', () =>
    assertBlocked(bash(`taskkill //PID 11111 //PID ${holderProc.pid}`), '一次多個 PID'));

  test('命中子指令外殼 pid（childPid）也擋', () =>
    assertBlocked(bash(`taskkill /PID ${childProc.pid} /F`), 'childPid'));

  test('PowerShell -Id 命中', () =>
    assertBlocked(bash(`Stop-Process -Id ${holderProc.pid} -Force`), 'Stop-Process -Id'));

  test('PowerShell -Id 逗號分隔多個，其中一個命中', () =>
    assertBlocked(bash(`Stop-Process -Id 22222,${holderProc.pid} -Force`), 'Stop-Process -Id 多個'));

  test('裸 kill（POSIX，帶訊號旗標）命中', () =>
    assertBlocked(bash(`kill -9 ${holderProc.pid}`), 'kill -9'));

  test('放行無關的 PID（不含 /IM、-Name、管線）', () =>
    assertPassed(bash('taskkill /PID 88888888 /F'), '無關 PID'));

  test('按名稱整批殺 /IM 一律擋（即使沒指名任何 PID）', () =>
    assertBlocked(bash('taskkill /IM node.exe /F'), 'taskkill /IM'));

  test('PowerShell -Name 一律擋', () =>
    assertBlocked(bash('Stop-Process -Name node -Force'), 'Stop-Process -Name'));

  test('管線送進 Stop-Process（目標非寫死數字）一律擋', () =>
    assertBlocked(
      bash("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { Stop-Process -Id $_.ProcessId }"),
      '管線送進 Stop-Process'
    ));

  test('不含殺行程字樣的指令不受影響', () => assertPassed(bash('npm test'), '無關指令'));

  test('擋下訊息點名專案、起始時間、SendMessage', () => {
    const r = killGuardCheck(bash(`taskkill /PID ${holderProc.pid} /F`));
    assert.match(r.message, /crm-system/);
    assert.match(r.message, /02:18/);
    assert.match(r.message, /SendMessage/);
    assert.match(r.message, /出貨全量/);
  });
});

describe('kill-guard：同一 session 在同一個專案裡放行（即使命中 PID）', () => {
  before(() => writeHolder({ session: 'my-session' }));
  after(() => clearHolder());

  test('hook stdin 帶 session_id 與持有方相同', () =>
    assertPassed(bash(`taskkill /PID ${holderProc.pid} /F`, { session_id: 'my-session', cwd: projCrm }), '同一 session（stdin）'));

  test('環境變數 CLAUDE_CODE_SESSION_ID 與持有方相同', () => {
    const orig = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'my-session';
    try {
      assertPassed(bash(`taskkill /PID ${holderProc.pid} /F`, { cwd: projCrm }), '同一 session（env）');
    } finally {
      if (orig === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = orig;
    }
  });

  test('兩個 session id 都在時，以 CODEX_SESSION_ID 為準（S9：Codex 從 Claude Code 內被啟動）', () => {
    const orig1 = process.env.CLAUDE_CODE_SESSION_ID;
    const orig2 = process.env.CODEX_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'outer-claude'; // 繼承自外層 Claude Code，不該被拿來比對
    process.env.CODEX_SESSION_ID = 'my-session';
    try {
      assertPassed(bash(`taskkill /PID ${holderProc.pid} /F`, { cwd: projCrm }), '同一 session（CODEX_SESSION_ID 優先）');
    } finally {
      if (orig1 === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = orig1;
      if (orig2 === undefined) delete process.env.CODEX_SESSION_ID; else process.env.CODEX_SESSION_ID = orig2;
    }
  });
});

describe('kill-guard：持有者已死時一律放行，並把過期登記作廢（M1）', () => {
  let deadPid;

  before(async () => {
    // 真的殺掉一個測試自己 spawn 的行程，而不是空想一個假 PID——這樣「pid 已死」是真實可觀察的
    // 行程狀態，不是靠猜一個現在剛好沒人用的號碼。
    const dying = spawn(process.execPath, ['-e', '']);
    deadPid = dying.pid;
    await new Promise(r => dying.on('exit', r));
    // Windows 上行程剛結束到系統完全回收之間可能有極短空窗，重試幾次避免測試本身假紅。
    for (let i = 0; i < 40; i++) {
      try { process.kill(deadPid, 0); } catch { break; }
      await new Promise(r => setTimeout(r, 50));
    }
  });

  test('持有者已死＋按名稱整批殺（原本一律擋的寫法）：改為放行，且把登記改名作廢', () => {
    writeHolder({ pid: deadPid, shellPid: deadPid });
    assertPassed(bash('taskkill /IM node.exe /F'), '持有者已死＋按名稱整批殺');
    assert.equal(existsSync(holderFile), false, '過期登記應該被改名作廢，不留在原路徑');
    try { rmSync(`${holderFile}.stale`, { force: true }); } catch {}
  });

  test('持有者已死＋指令原本會命中的 PID：一樣放行', () => {
    writeHolder({ pid: deadPid, shellPid: deadPid });
    assertPassed(bash(`taskkill /PID ${deadPid} /F`), '持有者已死＋命中 PID');
    try { rmSync(`${holderFile}.stale`, { force: true }); } catch {}
  });
});

describe('kill-guard：M3 對抗審查——各種繞過寫法都要擋下（別人持有鎖時）', () => {
  before(() => writeHolder());
  after(() => clearHolder());

  const cases = [
    ['positional 位置參數（不寫 -Id）', () => `Stop-Process ${holderProc.pid} -Force`],
    ['-Id 冒號寫法', () => `Stop-Process -Id:${holderProc.pid}`],
    ['-Id 陣列寫法 @(...)', () => `Stop-Process -Id @(${holderProc.pid})`],
    ['變數代入 -Id（PowerShell）', () => `$p=${holderProc.pid}; Stop-Process -Id $p`],
    ['spps 別名 + -Id', () => `spps -Id ${holderProc.pid}`],
    ['變數代入 //PID（Git Bash）', () => `PID=${holderProc.pid}; taskkill //PID $PID //F`],
    ['command substitution（POSIX kill）', () => 'kill -9 $(cat pidfile)'],
    ['/FI 篩選式（不是 /PID，看不出目標）', () => `taskkill /F /FI "PID eq ${holderProc.pid}"`],
    ['.Kill() 方法呼叫', () => `(Get-Process -Id ${holderProc.pid}).Kill()`],
    ['foreach 迴圈變數', () => `foreach ($i in @(${holderProc.pid})) { Stop-Process -Id $i }`],
    ['taskkill /FI IMAGENAME（不是 /IM，一樣按名稱）', () => 'taskkill /F /FI "IMAGENAME eq node.exe"'],
    ['管線 Get-Process | kill', () => 'Get-Process node | kill'],
    ['kill -Name（按名稱）', () => 'kill -Name node'],
    ['Stop-Process -n（-Name 縮寫）', () => 'Stop-Process -n node'],
    ['wmic ... delete（按名稱整批殺）', () => 'wmic process where name="node.exe" delete'],
    ['CIM Invoke-CimMethod -MethodName Terminate', () =>
      'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Invoke-CimMethod -MethodName Terminate'],
  ];
  for (const [label, buildCmd] of cases) {
    test(label, () => assertBlocked(bash(buildCmd()), label));
  }
});

describe('kill-guard：S1 對抗審查——唯讀查詢管線不該被誤擋（別人持有鎖時）', () => {
  before(() => writeHolder());
  after(() => clearHolder());

  test('git log -p | grep -n taskkill：只是查字串，不是真的在殺', () =>
    assertPassed(bash('git log -p | grep -n taskkill'), 'grep 查 taskkill 字樣'));
  test('git diff | findstr /i taskkill', () =>
    assertPassed(bash('git diff | findstr /i taskkill'), 'findstr 查 taskkill 字樣'));
  test('cat DESIGN.md | grep -c taskkill', () =>
    assertPassed(bash('cat DESIGN.md | grep -c taskkill'), 'grep -c 計數'));
  test("Get-Content x | Select-String 'Stop-Process'", () =>
    assertPassed(bash("Get-Content x | Select-String 'Stop-Process'"), 'Select-String 查字串'));
  test('-Name 屬於唯讀敘述（Get-Process），taskkill /PID 是另一條無關敘述：整條放行', () =>
    assertPassed(
      bash('Get-Process -Name node | Select-Object Id; taskkill /PID 88888888 /F'),
      '-Name 跟殺行程動詞不在同一條敘述'
    ));
});

// 語料重放實測（wave5/merged-corpus.json 9,209 條真實指令）找出的兩個誤擋成因：
// 1) splitStatements() 把 grep 基本正則（BRE）跳脫過的 `\|`（or）當成 shell 管線邊界切開，
//    切出以 taskkill／Stop-Process／kill 開頭的片段而誤判——常見於 `grep -n '甲\|乙\|taskkill' file`
//    這種查字串的唯讀指令。
// 2) KILL_LEADER_RE 原本用 `\b` 當邊界，`-`／`.` 都算邊界字元，導致 `kill-guard.mjs`、`kill-guard.test`、
//    `kill.ps1`、`taskkill-report.ps1` 這類以動詞開頭的識別字／檔名也命中。
describe('kill-guard：wave5 對抗審查修正——跳脫管線與 kill- 開頭識別字不該被誤擋（別人持有鎖時）', () => {
  before(() => writeHolder());
  after(() => clearHolder());

  test('grep 用 BRE 跳脫 \\| 列關鍵字，taskkill 只是被查的字串之一（成因 1）', () =>
    assertPassed(bash("grep -n \"萬字\\|斷路器\\|taskkill\\|千字\" README.md"), 'BRE \\| 列表裡的 taskkill'));

  test('grep -o 用 \\| 串接兩段規則運算式，Stop-Process 只是規則的一部分（成因 1）', () =>
    assertPassed(
      bash("grep -n -o 'taskkill[^\"\\\\]\\{0,80\\}\\|Stop-Process[^\"\\\\]\\{0,80\\}' file.jsonl"),
      'BRE \\| 串接規則運算式片段'
    ));

  test('grep 用 \\| 列關鍵字，其中一個剛好是 kill-guard.mjs 這種識別字（成因 1＋2 疊加）', () =>
    assertPassed(
      bash("grep -n \"機器鎖\\|殺行程守門\\|kill-guard.mjs\\|決議 026\" DESIGN.md"),
      'kill-guard.mjs 識別字'
    ));

  test('kill-guard.mjs 當成單一敘述（不經過管線切分）也不該被當成裸 kill 呼叫（成因 2）', () =>
    assertPassed(bash('kill-guard.mjs --self-check'), 'kill-guard.mjs 開頭識別字'));

  test('kill.ps1 這種檔名（kill 後面接句點）不該被當成裸 kill 呼叫（成因 2）', () =>
    assertPassed(bash('kill.ps1 -Confirm:$false'), 'kill.ps1 開頭識別字'));

  test('taskkill-report.ps1 這種識別字，taskkill 等其他動詞邊界比照同一原則（成因 2）', () =>
    assertPassed(bash('taskkill-report.ps1 -Verbose'), 'taskkill- 開頭識別字'));
});

// 決議 033：出貨鎖每個專案一把，守門讀全部專案的登記取聯集。迴圈裡「持有者已死」「同 session」兩個分支
// 都只能跳過那一份、繼續檢查下一份，不能直接放行整條指令。
describe('kill-guard：決議 033 多專案登記取聯集', () => {
  let projB, deadPid;
  before(async () => {
    projB = makeProject('proj-b');
    const dying = spawn(process.execPath, ['-e', '']);
    deadPid = dying.pid;
    await new Promise(r => dying.on('exit', r));
    for (let i = 0; i < 40; i++) {
      try { process.kill(deadPid, 0); } catch { break; }
      await new Promise(r => setTimeout(r, 50));
    }
  });
  afterEach(() => clearAllHolders());

  const otherProject = (overrides = {}) => ({
    root: projB, session: 'other-session-b', pid: holder2Proc.pid, shellPid: child2Proc.pid, ...overrides,
  });

  test('兩個專案各有別人持有的登記：殺第二個專案的 PID 也擋（取聯集，不是只看第一份）', () => {
    writeHolder({}, 'k-aaa');
    writeHolder(otherProject(), 'k-zzz');
    const r = assertBlocked(bash(`taskkill /PID ${holder2Proc.pid} /F`), '第二個專案的 runner pid');
    assert.match(r.message, /proj-b/, '訊息要點名真正被殺的那個專案');
    assertBlocked(bash(`taskkill /PID ${child2Proc.pid} /F`), '第二個專案的子指令外殼 pid');
    const r1 = assertBlocked(bash(`taskkill /PID ${holderProc.pid} /F`), '第一個專案的 runner pid');
    assert.match(r1.message, /crm-system/);
  });

  test('只有別專案持有，也擋：跨專案的出貨全量同樣是別人的行程', () => {
    writeHolder(otherProject(), 'k-zzz');
    assertBlocked(bash(`taskkill /PID ${holder2Proc.pid} /F`), '只有別專案的登記');
    assertBlocked(bash('taskkill /IM node.exe /F'), '只有別專案的登記＋按名稱整批殺');
  });

  for (const [label, deadKey] of [['已死登記排在前面', 'k-000-dead'], ['已死登記排在後面', 'k-zzz-dead']]) {
    test(`一份已死登記＋一份別 session 活登記：仍擋（${label}），已死那份順手作廢`, () => {
      writeHolder({ pid: deadPid, shellPid: deadPid, session: 'whoever' }, deadKey);
      writeHolder({}, 'k-mid');
      assertBlocked(bash(`taskkill /PID ${holderProc.pid} /F`), '已死＋活的：命中活的 pid');
      assertBlocked(bash('taskkill /IM node.exe /F'), '已死＋活的：按名稱整批殺');
      assert.equal(existsSync(holderFileOf(deadKey)), false, '已死登記應被改名作廢');
      assert.equal(existsSync(`${holderFileOf(deadKey)}.stale`), true);
      assert.equal(existsSync(holderFileOf('k-mid')), true, '活的登記不該被動到');
    });
  }

  test('一份同 session 登記＋一份別 session 活登記：殺別人的仍擋，殺自己的放行', () => {
    writeHolder({ session: 'my-session' }, 'k-mine'); // 我自己的出貨（crm-system）
    writeHolder(otherProject(), 'k-other');
    const input = extra => ({ session_id: 'my-session', cwd: projCrm, ...extra });
    assertBlocked(bash(`taskkill /PID ${holder2Proc.pid} /F`, input()), '殺別人的 runner');
    assertBlocked(bash(`taskkill /PID ${child2Proc.pid} /F`, input()), '殺別人的子指令外殼');
    assertBlocked(bash('taskkill /IM node.exe /F', input()), '別人還持有時，按名稱整批殺也擋');
    assertPassed(bash(`taskkill /PID ${holderProc.pid} /F`, input()), '殺自己的 runner');
  });

  test('同 session 但 cwd 在另一個專案：當成別人處理，要擋', () => {
    writeHolder({ session: 'my-session' }, 'k-mine');
    assertBlocked(bash(`taskkill /PID ${holderProc.pid} /F`, { session_id: 'my-session', cwd: projB }), 'cwd 是別的專案');
    assertBlocked(bash(`taskkill /PID ${holderProc.pid} /F`, { session_id: 'my-session' }),
      '沒帶 cwd 時退回本行程的 cwd（不是那個專案），一樣擋');
  });

  test('同 session 且 cwd 在該專案的子目錄、或同 repo 的另一個 worktree：換算成主工作樹根後同專案，放行', () => {
    writeHolder({ session: 'my-session' }, 'k-mine');
    const sub = join(projCrm, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    assertPassed(bash(`taskkill /PID ${holderProc.pid} /F`, { session_id: 'my-session', cwd: sub }), '專案子目錄');

    // 手工搭 git worktree 的形狀（不叫 git）：worktree 根的 .git 是檔案、commondir 指回主 repo 的 .git
    const wt = join(projBase, 'crm-system-wt');
    mkdirSync(join(projCrm, '.git', 'worktrees', 'wt'), { recursive: true });
    writeFileSync(join(projCrm, '.git', 'worktrees', 'wt', 'commondir'), '../..\n', 'utf8');
    mkdirSync(join(wt, '.constellation'), { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: ' + join(projCrm, '.git', 'worktrees', 'wt') + '\n', 'utf8');
    assertPassed(bash(`taskkill /PID ${holderProc.pid} /F`, { session_id: 'my-session', cwd: wt }), '同 repo 的另一個 worktree');
  });

  test('相容舊版：leases/machine 的登記（沒有 key 欄位）新版也讀得到、也擋', () => {
    writeHolder({ key: undefined }, 'machine'); // 決議 026 舊格式：沒有 key，只有 root
    assertBlocked(bash(`taskkill /PID ${holderProc.pid} /F`), '舊版 machine 登記');
    assertBlocked(bash('taskkill /IM node.exe /F'), '舊版 machine 登記＋按名稱整批殺');
  });

  test('相容舊版：舊登記同 session 且 cwd 在它的 root 放行（專案鍵由 root 算）；cwd 在別處照擋', () => {
    writeHolder({ key: undefined, session: 'my-session' }, 'machine');
    assertPassed(bash(`taskkill /PID ${holderProc.pid} /F`, { session_id: 'my-session', cwd: projCrm }), '舊登記同專案同 session');
    assertBlocked(bash(`taskkill /PID ${holderProc.pid} /F`, { session_id: 'my-session', cwd: projB }), '舊登記同 session 不同專案');
  });

  test('壞掉的登記不擋事（fail-open），也不影響旁邊正常登記的判定', () => {
    mkdirSync(join(leasesDir, 'k-bad'), { recursive: true });
    writeFileSync(holderFileOf('k-bad'), '{not json');
    assertPassed(bash(`taskkill /PID ${holderProc.pid} /F`), '只有壞登記');
    writeHolder({}, 'k-ok');
    assertBlocked(bash(`taskkill /PID ${holderProc.pid} /F`), '壞登記旁邊的正常登記照擋');
  });
});
