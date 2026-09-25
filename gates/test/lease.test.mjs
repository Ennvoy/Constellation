// gates/test/lease.test.mjs — gates/lease.mjs 的單元測試（機器鎖：搶／查／釋放，決議 026）。
// lease.mjs 不會在 import 時自動執行任何東西（CLI 分支有 import.meta.url 守門），可以直接 import
// 進本檔在同一個行程裡呼叫——不必每個案例都開子行程。homedir() 每次呼叫都重新查 USERPROFILE／HOME，
// 所以每個案例前把這兩個環境變數指到一個全新的拋棄式假家目錄，就能讓 leaseDir() 互不干擾。
// 「持有方」一律用測試自己 spawn 的真行程模擬（見「用假行程模擬持有方」那個 describe），
// 不憑空捏造 PID——避免撞到真正在跑的其他行程。
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lease from '../lease.mjs';

const LEASE_MJS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lease.mjs');

const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_HOME = process.env.HOME;

let fakeHome;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'lease-home-'));
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
});

afterEach(() => {
  process.env.USERPROFILE = ORIG_USERPROFILE;
  process.env.HOME = ORIG_HOME;
  try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
});

function sampleEntry(overrides = {}) {
  return {
    root: 'C:/fake/project',
    session: 'test-session',
    runtime: 'test',
    pid: process.pid,
    startedAt: lease.myStartedAtMs(),
    purpose: '測試用途',
    estimatedEndAt: null,
    shellPid: null,
    ...overrides,
  };
}

describe('lease：搶鎖／查鎖', () => {
  test('沒有人持有時：acquire 成功，登記檔內容原樣寫入', () => {
    const entry = sampleEntry();
    const r = lease.acquire(entry);
    assert.equal(r.ok, true);
    assert.ok(existsSync(lease.holderPath()));
    const saved = JSON.parse(readFileSync(lease.holderPath(), 'utf8'));
    assert.equal(saved.pid, entry.pid);
    assert.equal(saved.startedAt, entry.startedAt);
    assert.equal(saved.purpose, '測試用途');
  });

  test('已有人持有時：acquire 失敗（wx 撞到既存檔案），回傳目前持有者內容', () => {
    const first = sampleEntry({ purpose: '第一個' });
    assert.equal(lease.acquire(first).ok, true);

    const second = sampleEntry({ purpose: '第二個', pid: process.pid + 1 });
    const r2 = lease.acquire(second);
    assert.equal(r2.ok, false);
    assert.ok(r2.holder, '應回傳目前持有者');
    assert.equal(r2.holder.purpose, '第一個', '不該被第二次 acquire 覆蓋');
  });

  test('readHolder：檔案不存在、或內容壞掉，一律 fail-safe 回 null', () => {
    assert.equal(lease.readHolder(), null, '檔案不存在');
    mkdirSync(lease.leaseDir(), { recursive: true });
    writeFileSync(lease.holderPath(), '{ 這不是合法 JSON', 'utf8');
    assert.equal(lease.readHolder(), null, '壞掉的 JSON 也回 null，不丟例外');
  });

  test('isPidAlive：自己的 pid 算存活；行程真的死透之後回 false（不用空想的假 PID）', async () => {
    assert.equal(lease.isPidAlive(process.pid), true);

    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 100)']);
    const childPid = child.pid;
    await new Promise(resolve => child.on('exit', resolve));
    // Windows 上行程剛結束到系統完全回收之間可能有極短空窗，重試幾次避免測試本身假紅。
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      alive = lease.isPidAlive(childPid);
      if (alive) await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(alive, false, `子行程 ${childPid} 應已判定死亡`);
  });
});

describe('lease：釋放與作廢——動手前一定先比對身分', () => {
  test('release：識別碼對得上才刪除；不對就不動它（防「失效接手後把新持有者殺掉」）', () => {
    const mine = sampleEntry();
    lease.acquire(mine);

    // 先用錯的識別碼呼叫 release：不該刪到登記。
    const wrongIdentity = { pid: mine.pid, startedAt: mine.startedAt + 999 };
    assert.equal(lease.release(wrongIdentity), true, '回傳值仍是 true（視為安全放行），但檔案不該被動到');
    assert.ok(existsSync(lease.holderPath()), '身分不對，登記應該還在');

    // 用對的識別碼才真的釋放。
    const rightIdentity = { pid: mine.pid, startedAt: mine.startedAt };
    assert.equal(lease.release(rightIdentity), true);
    assert.equal(existsSync(lease.holderPath()), false, '身分對得上，登記應被刪除');
  });

  test('release：檔案本來就不存在時視為成功（冪等）', () => {
    const identity = { pid: 999999, startedAt: 0 };
    assert.equal(lease.release(identity), true);
  });

  test('invalidate：expectedHolder 對得上才改名作廢；換了新持有者就不動', () => {
    const original = sampleEntry({ pid: process.pid, purpose: '原持有者' });
    lease.acquire(original);
    const originalSnapshot = lease.readHolder();

    // 模擬「這一瞬間剛換上新持有者」：先把原檔搬走、放一份不同身分的新登記進去。
    // （不直接呼叫 invalidate 兩次製造 race，而是明確重寫檔案模擬新持有者已經接手的現況。）
    const replaced = sampleEntry({ pid: process.pid + 1, startedAt: original.startedAt + 12345, purpose: '新持有者' });
    writeFileSync(lease.holderPath(), JSON.stringify(replaced, null, 2), 'utf8');

    const ok = lease.invalidate(originalSnapshot); // 呼叫端仍拿著「舊」快照
    assert.equal(ok, true, '找不到匹配的舊登記時仍回 true（現況已經不是那一筆，視為成功）');
    const stillThere = lease.readHolder();
    assert.equal(stillThere.purpose, '新持有者', '新持有者的登記不該被誤刪');
  });

  test('invalidate：expectedHolder 對得上時真的改名，之後可以重新 acquire', () => {
    const entry = sampleEntry();
    lease.acquire(entry);
    const snapshot = lease.readHolder();

    assert.equal(lease.invalidate(snapshot), true);
    assert.equal(lease.readHolder(), null, '原路徑應已被改名，讀不到');
    assert.equal(existsSync(`${lease.holderPath()}.stale`), true, '應該留一份改名後的失效紀錄');

    const next = sampleEntry({ purpose: '重新搶到的' });
    assert.equal(lease.acquire(next).ok, true, '改名騰出路徑後，下一個搶鎖者應該成功');
  });

  test('invalidateCorrupt（S2）：登記檔壞掉（解析不出來）時把它改名作廢，之後可以重新 acquire', () => {
    mkdirSync(lease.leaseDir(), { recursive: true });
    writeFileSync(lease.holderPath(), '{ 這不是合法 JSON', 'utf8');

    assert.equal(lease.invalidateCorrupt(), true);
    assert.equal(existsSync(lease.holderPath()), false, '壞掉的登記應該被改名搬走');
    assert.equal(existsSync(`${lease.holderPath()}.stale`), true, '應該留一份改名後的失效紀錄');

    const next = sampleEntry({ purpose: '重新搶到的' });
    assert.equal(lease.acquire(next).ok, true, '改名騰出路徑後，下一個搶鎖者應該成功');
  });

  test('invalidateCorrupt：檔案這時已經變成合法登記（別人剛好接手），不該誤刪', () => {
    const legit = sampleEntry({ purpose: '合法新持有者' });
    lease.acquire(legit);

    assert.equal(lease.invalidateCorrupt(), true, '現況已是合法登記，視為成功但不動手');
    const still = lease.readHolder();
    assert.ok(still, '合法登記不該被 invalidateCorrupt 誤刪');
    assert.equal(still.purpose, '合法新持有者');
  });
});

describe('lease：其他欄位', () => {
  test('updateShellPid：身分對得上才更新，且只改 shellPid 這個欄位', () => {
    const entry = sampleEntry({ purpose: '不該被動到' });
    lease.acquire(entry);
    const identity = { pid: entry.pid, startedAt: entry.startedAt };

    lease.updateShellPid(identity, 4321);
    const after = lease.readHolder();
    assert.equal(after.shellPid, 4321);
    assert.equal(after.purpose, '不該被動到', '其餘欄位應原樣保留');

    lease.updateShellPid({ pid: entry.pid, startedAt: entry.startedAt + 1 }, 9999);
    assert.equal(lease.readHolder().shellPid, 4321, '身分不對時不該更新');
  });

  test('estimateEndFromShipEvidence：抓最後一筆「耗時：合計 Ns」並回傳 ISO 字串；抓不到回 null', () => {
    const proj = mkdtempSync(join(tmpdir(), 'lease-proj-'));
    try {
      mkdirSync(join(proj, '.constellation'), { recursive: true });
      assert.equal(lease.estimateEndFromShipEvidence(proj), null, '證據檔不存在時回 null');

      writeFileSync(join(proj, '.constellation', 'ship-evidence.md'), [
        '## 驗證證據',
        '- **2026-01-01T00:00:00.000Z**',
        '  - `cmd a`（exit 0）',
        '  - 耗時：合計 10s｜cmd a 10s',
        '- **2026-01-02T00:00:00.000Z**',
        '  - `cmd b`（exit 0）',
        '  - 耗時：合計 42s｜cmd b 42s',
      ].join('\n'), 'utf8');

      const before = Date.now();
      const est = lease.estimateEndFromShipEvidence(proj);
      assert.ok(est, '應該解析出估計值');
      const deltaSec = (new Date(est).getTime() - before) / 1000;
      assert.ok(deltaSec > 40 && deltaSec < 44, `應以最後一筆（42s）估算，實際 delta=${deltaSec}s`);
    } finally {
      try { rmSync(proj, { recursive: true, force: true }); } catch {}
    }
  });

  test('formatHolder：印得出必要欄位，不因缺欄位而丟例外', () => {
    const text = lease.formatHolder({ pid: process.pid });
    assert.match(text, /PID/);
    assert.match(text, /存活/);
    assert.match(text, /（不明）/);
  });
});

describe('lease CLI：只開放 list', () => {
  let cliHome;
  before(() => { cliHome = mkdtempSync(join(tmpdir(), 'lease-cli-home-')); });
  after(() => { try { rmSync(cliHome, { recursive: true, force: true }); } catch {} });

  function runCli(args) {
    return spawnSync(process.execPath, [LEASE_MJS, ...args], {
      env: { ...process.env, USERPROFILE: cliHome, HOME: cliHome },
      encoding: 'utf8',
      timeout: 15_000,
    });
  }

  test('沒有人持有時：list 印「目前沒有人持有機器鎖」，exit 0', () => {
    const r = runCli(['list']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /目前沒有人持有機器鎖/);
  });

  test('有人持有時：list 印出持有者摘要，exit 0', () => {
    mkdirSync(join(cliHome, '.constellation', 'leases', 'machine'), { recursive: true });
    writeFileSync(
      join(cliHome, '.constellation', 'leases', 'machine', 'holder.json'),
      JSON.stringify(sampleEntry({ root: 'C:/somewhere', purpose: '出貨全量驗證' }), null, 2),
      'utf8',
    );
    const r = runCli(['list']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /機器鎖持有中/);
    assert.match(r.stdout, /出貨全量驗證/);
    assert.match(r.stdout, /C:\/somewhere/);
  });

  test('不支援的子指令：印用法、exit 1', () => {
    const r = runCli(['stop']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /用法：/);
  });

  test('登記檔存在但壞掉（S2）：照實說「讀不出來」，不能講成「沒有人持有」', () => {
    const dir = join(cliHome, '.constellation', 'leases', 'machine');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'holder.json'), '', 'utf8'); // 0 位元組
    try {
      const r = runCli(['list']);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /讀不出來/, '應照實講壞掉，不是空手放行成「沒有人持有」');
      assert.doesNotMatch(r.stdout, /目前沒有人持有機器鎖/);
    } finally {
      try { rmSync(join(dir, 'holder.json'), { force: true }); } catch {}
    }
  });
});
