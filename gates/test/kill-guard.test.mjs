// gates/test/kill-guard.test.mjs — 殺行程守門黑箱測試。
// killGuardCheck 是純函式（gates/kill-guard.mjs 沒有任何自動執行的入口，homedir() 特意延後到
// 呼叫當下才取值），直接 import 呼叫即可，不必為這支閘門另外 spawn 子行程去跑 pre-tool-use.mjs
// （dispatcher 整合驗證留給 pre-tool-use.test.mjs）。
//
// 安全規則：全程把 USERPROFILE／HOME 指到本檔自建的拋棄式假家目錄，holder.json 只寫在假目錄
// 底下，絕不碰真正的 ~/.constellation/leases；「持有方」一律用本檔自己 spawn 的 sleeper 行程
// 的真實 PID 模擬，killGuardCheck 本身是純判定函式、不會 shell out，本檔從頭到尾不會真的執行
// 任何一句 taskkill／Stop-Process／kill。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { killGuardCheck } from '../kill-guard.mjs';

const bash = (command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, ...extra });

let fakeHome, holderFile, origUserProfile, origHome;
let holderProc, childProc; // 測試自己 spawn 的假行程，模擬持有方——絕不用機器上真實的其他行程

before(() => {
  origUserProfile = process.env.USERPROFILE;
  origHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'kg-home-'));
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  const holderDir = join(fakeHome, '.constellation', 'leases', 'machine');
  mkdirSync(holderDir, { recursive: true });
  holderFile = join(holderDir, 'holder.json');

  // 兩個無害的 sleeper 行程只用來提供真實 PID；.pid 在 spawn() 呼叫後就同步可用，不必等它們
  // 真的跑起來——本檔不判存活，純粹拿數字。
  holderProc = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 300000)']);
  childProc = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 300000)']);
});

after(() => {
  for (const p of [holderProc, childProc]) { try { p.kill(); } catch {} }
  if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile;
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
});

// 欄位名稱與 gates/lease.mjs／verify-runner.mjs 的 acquireShipLease 實際寫入的 holder.json 一致：
// root、session、runtime、pid、startedAt、purpose、estimatedEndAt、shellPid。
function writeHolder(overrides = {}) {
  const holder = {
    root: 'C:\\Users\\ennvoy.lin\\Desktop\\crm-system',
    session: 'other-session',
    runtime: 'claude',
    pid: holderProc.pid,
    startedAt: new Date(2026, 8, 25, 2, 18).getTime(), // 09-25 02:18（本機時區）
    purpose: 'ship 全量驗證',
    estimatedEndAt: null,
    shellPid: childProc.pid,
    ...overrides,
  };
  writeFileSync(holderFile, JSON.stringify(holder));
  return holder;
}
function clearHolder() {
  try { unlinkSync(holderFile); } catch {}
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

describe('kill-guard：沒人持有 machine 鎖', () => {
  before(() => clearHolder());
  test('taskkill 任意 PID 都放行', () => assertPassed(bash('taskkill /PID 99999 /F'), '無持有者'));
  test('holder.json 壞掉（非法 JSON）也放行（fail-open）', () => {
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

describe('kill-guard：同一 session 放行（即使命中 PID）', () => {
  before(() => writeHolder({ session: 'my-session' }));
  after(() => clearHolder());

  test('hook stdin 帶 session_id 與持有方相同', () =>
    assertPassed(bash(`taskkill /PID ${holderProc.pid} /F`, { session_id: 'my-session' }), '同一 session（stdin）'));

  test('環境變數 CLAUDE_CODE_SESSION_ID 與持有方相同', () => {
    const orig = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'my-session';
    try {
      assertPassed(bash(`taskkill /PID ${holderProc.pid} /F`), '同一 session（env）');
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
      assertPassed(bash(`taskkill /PID ${holderProc.pid} /F`), '同一 session（CODEX_SESSION_ID 優先）');
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
