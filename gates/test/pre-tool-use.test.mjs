// gates/test/pre-tool-use.test.mjs — P18 回歸：非 git 指令不再載入 git 守門／commit 守門，
// 但兩道閘門原本的判定結果（含 tool_input／toolInput 兩種鍵名）必須一字不差地維持。
// 另補殺行程守門的 dispatcher 整合驗證（規則細節見 kill-guard.test.mjs，這裡只驗證快速放行
// 條件有沒有正確接上、exit code／stderr 有沒有正確傳遞）。
// pre-tool-use.mjs 本身沒有 export 的純函式（stdin 導向），黑箱 spawn 驗證。
//
// 對抗審查 should-fix：commit-gate 沒有 .constellation 專案就 fail-open放行，「真繞過 commit」那個
// 案例原本沒帶 cwd，靠 commitGateCheck 內部 fallback 到 process.cwd()——測試能不能過因此取決於跑
// 測試時人站在哪個目錄（在有 .constellation 的目錄下才會過），還混到真實 repo 的 staged 狀態。改法：
// 造一個獨立的暫存 git repo（有 .constellation），commit 相關案例一律明確帶 cwd 指向它。
//
// 殺行程守門的案例一律把 USERPROFILE／HOME 指到本檔自建的拋棄式假家目錄（子行程 env 層級隔離，
// 不影響本測試行程自身），holder.json 只寫在假目錄底下，絕不碰真正的 ~/.constellation/leases；
// 「持有方」用本檔自己 spawn 的 sleeper 行程的真實 PID 模擬，全程不會真的執行任何殺行程指令。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pre-tool-use.mjs');

let repo, fakeHome, holderProc, childProc;

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'ptu-test-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  spawnSync('git', ['config', 'user.email', 'a@b.c'], { cwd: repo });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  mkdirSync(join(repo, '.constellation'), { recursive: true });

  fakeHome = mkdtempSync(join(tmpdir(), 'ptu-home-'));
  mkdirSync(join(fakeHome, '.constellation', 'leases', 'machine'), { recursive: true });
  holderProc = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 300000)']);
  childProc = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 300000)']);
});

after(() => {
  rmSync(repo, { recursive: true, force: true });
  for (const p of [holderProc, childProc]) { try { p.kill(); } catch {} }
  rmSync(fakeHome, { recursive: true, force: true });
});

function run(input, extraEnv = {}) {
  const r = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  return { status: r.status, stderr: r.stderr || '' };
}

// 欄位名稱與 gates/lease.mjs／verify-runner.mjs 的 acquireShipLease 實際寫入的 holder.json 一致：
// root、session、runtime、pid、startedAt、purpose、estimatedEndAt、shellPid。
const holderFile = () => join(fakeHome, '.constellation', 'leases', 'machine', 'holder.json');
function writeHolder(overrides = {}) {
  writeFileSync(holderFile(), JSON.stringify({
    root: 'C:\\Users\\ennvoy.lin\\Desktop\\crm-system',
    session: 'other-session',
    runtime: 'claude',
    pid: holderProc.pid,
    startedAt: Date.now(),
    purpose: 'ship 全量驗證',
    estimatedEndAt: null,
    shellPid: childProc.pid,
    ...overrides,
  }));
}
function runWithHome(input, extraEnv = {}) {
  return run(input, { USERPROFILE: fakeHome, HOME: fakeHome, ...extraEnv });
}

describe('pre-tool-use：P18——非 git 指令快速放行，git 指令維持雙閘門判定', () => {
  test('非 git 指令：exit 0', () => {
    const r = run({ tool_name: 'Bash', tool_input: { command: 'ls -la && npm test' } });
    assert.equal(r.status, 0);
  });

  test('非 git 指令（camelCase toolInput）：exit 0', () => {
    const r = run({ tool_name: 'Bash', toolInput: { command: 'echo hello' } });
    assert.equal(r.status, 0);
  });

  test('危險 git 指令（tool_input，snake_case）仍被 git-guardrail 擋下', () => {
    const r = run({ tool_name: 'Bash', tool_input: { command: 'git checkout -b feature' } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /git 守門/);
  });

  test('危險 git 指令（toolInput，camelCase）仍被 git-guardrail 擋下——prefilter 兩種鍵名都要認', () => {
    const r = run({ tool_name: 'Bash', toolInput: { command: 'git push --force origin main' } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /git 守門/);
  });

  test('真繞過 commit（--no-verify）仍被 commit-gate 擋下（明確帶 cwd，不靠站的目錄猜）', () => {
    const r = run({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'git commit --no-verify -m "x"' } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /commit 守門/);
  });

  test('commit 後接 sed -n：-n 屬於 sed，放行（P4 放行類別 (A)，經 dispatcher 整合驗證一次）', () => {
    const r = run({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'git commit -m "x" && sed -n 1,5p a.md' } });
    assert.equal(r.status, 0);
  });

  test('唯讀 git 指令放行', () => {
    const r = run({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'git status && git log -3' } });
    assert.equal(r.status, 0);
  });
});

describe('pre-tool-use：殺行程守門——快速放行條件有沒有正確接上 kill-guard（規則細節見 kill-guard.test.mjs）', () => {
  test('完全不含殺行程字樣：exit 0（"skills" 字樣的 kill 子字串不誤命中）', () => {
    const r = run({ tool_name: 'Bash', tool_input: { command: 'ls skills/ && npm test' } });
    assert.equal(r.status, 0);
  });

  test('S1：快速放行條件不再要求 kill 後面帶數字——管線 kill（無數字）一樣會載入 kill-guard 判定', () => {
    writeHolder();
    const r = runWithHome({ tool_name: 'Bash', tool_input: { command: 'Get-Process node | kill' } });
    assert.equal(r.status, 2, '沒有數字目標的裸 kill 一樣要能觸發載入並被判定為不安全');
    assert.match(r.stderr, /SendMessage/);
  });

  test('沒人持有 machine 鎖時，taskkill 任意 PID 放行', () => {
    const r = runWithHome({ tool_name: 'Bash', tool_input: { command: 'taskkill /PID 99999 /F' } });
    assert.equal(r.status, 0);
  });

  test('別人持有鎖、命中其 PID：exit 2，訊息點名專案＋要求走 SendMessage', () => {
    writeHolder();
    const r = runWithHome({ tool_name: 'Bash', tool_input: { command: `taskkill /PID ${holderProc.pid} /F` } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /crm-system/);
    assert.match(r.stderr, /SendMessage/);
  });

  test('別人持有鎖、命中無關 PID：仍放行', () => {
    writeHolder();
    const r = runWithHome({ tool_name: 'Bash', tool_input: { command: 'taskkill /PID 88888888 /F' } });
    assert.equal(r.status, 0);
  });

  test('裸 kill 帶數字命中持有方也擋——不需要 git／taskkill 字樣', () => {
    writeHolder();
    const r = runWithHome({ tool_name: 'Bash', tool_input: { command: `kill -9 ${holderProc.pid}` } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /SendMessage/);
  });

  test('同一 session（環境變數 CLAUDE_CODE_SESSION_ID 相符）放行，即使命中 PID', () => {
    writeHolder({ session: 'my-session' });
    const r = runWithHome(
      { tool_name: 'Bash', tool_input: { command: `taskkill /PID ${holderProc.pid} /F` } },
      { CLAUDE_CODE_SESSION_ID: 'my-session' }
    );
    assert.equal(r.status, 0);
  });
});
