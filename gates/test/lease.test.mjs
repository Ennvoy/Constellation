// gates/test/lease.test.mjs — gates/lease.mjs 的單元測試（出貨鎖：搶／查／釋放，決議 026；每專案一把，決議 033）。
// lease.mjs 不會在 import 時自動執行任何東西（CLI 分支有 import.meta.url 守門），可以直接 import
// 進本檔在同一個行程裡呼叫——不必每個案例都開子行程。homedir() 每次呼叫都重新查 USERPROFILE／HOME，
// 所以每個案例前把這兩個環境變數指到一個全新的拋棄式假家目錄，就能讓 leaseDir() 互不干擾。
// 登記檔一律寫在假家目錄底下的 .constellation/leases/<key>/，絕不碰真正的 ~/.constellation/leases。
// 「持有方」一律用測試自己 spawn 的真行程模擬（見「用假行程模擬持有方」那個 describe），
// 不憑空捏造 PID——避免撞到真正在跑的其他行程。
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lease from '../lease.mjs';

const LEASE_MJS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lease.mjs');

const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_HOME = process.env.HOME;
const KEY = 'proj-a'; // 多數案例只需要「某一個專案」的登記，鍵的內容不重要（真實鍵由 projectKey 算）

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
    const r = lease.acquire(KEY, entry);
    assert.equal(r.ok, true);
    assert.ok(existsSync(lease.holderPath(KEY)));
    const saved = JSON.parse(readFileSync(lease.holderPath(KEY), 'utf8'));
    assert.equal(saved.pid, entry.pid);
    assert.equal(saved.startedAt, entry.startedAt);
    assert.equal(saved.purpose, '測試用途');
  });

  test('已有人持有時：acquire 失敗（wx 撞到既存檔案），回傳目前持有者內容', () => {
    const first = sampleEntry({ purpose: '第一個' });
    assert.equal(lease.acquire(KEY, first).ok, true);

    const second = sampleEntry({ purpose: '第二個', pid: process.pid + 1 });
    const r2 = lease.acquire(KEY, second);
    assert.equal(r2.ok, false);
    assert.ok(r2.holder, '應回傳目前持有者');
    assert.equal(r2.holder.purpose, '第一個', '不該被第二次 acquire 覆蓋');
  });

  test('readHolder：檔案不存在、或內容壞掉，一律 fail-safe 回 null', () => {
    assert.equal(lease.readHolder(KEY), null, '檔案不存在');
    mkdirSync(lease.leaseDir(KEY), { recursive: true });
    writeFileSync(lease.holderPath(KEY), '{ 這不是合法 JSON', 'utf8');
    assert.equal(lease.readHolder(KEY), null, '壞掉的 JSON 也回 null，不丟例外');
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
    lease.acquire(KEY, mine);

    // 先用錯的識別碼呼叫 release：不該刪到登記。
    const wrongIdentity = { pid: mine.pid, startedAt: mine.startedAt + 999 };
    assert.equal(lease.release(KEY, wrongIdentity), true, '回傳值仍是 true（視為安全放行），但檔案不該被動到');
    assert.ok(existsSync(lease.holderPath(KEY)), '身分不對，登記應該還在');

    // 用對的識別碼才真的釋放。
    const rightIdentity = { pid: mine.pid, startedAt: mine.startedAt };
    assert.equal(lease.release(KEY, rightIdentity), true);
    assert.equal(existsSync(lease.holderPath(KEY)), false, '身分對得上，登記應被刪除');
  });

  test('release：檔案本來就不存在時視為成功（冪等）', () => {
    const identity = { pid: 999999, startedAt: 0 };
    assert.equal(lease.release(KEY, identity), true);
  });

  test('invalidate：expectedHolder 對得上才改名作廢；換了新持有者就不動', () => {
    const original = sampleEntry({ pid: process.pid, purpose: '原持有者' });
    lease.acquire(KEY, original);
    const originalSnapshot = lease.readHolder(KEY);

    // 模擬「這一瞬間剛換上新持有者」：先把原檔搬走、放一份不同身分的新登記進去。
    // （不直接呼叫 invalidate 兩次製造 race，而是明確重寫檔案模擬新持有者已經接手的現況。）
    const replaced = sampleEntry({ pid: process.pid + 1, startedAt: original.startedAt + 12345, purpose: '新持有者' });
    writeFileSync(lease.holderPath(KEY), JSON.stringify(replaced, null, 2), 'utf8');

    const ok = lease.invalidate(KEY, originalSnapshot); // 呼叫端仍拿著「舊」快照
    assert.equal(ok, true, '找不到匹配的舊登記時仍回 true（現況已經不是那一筆，視為成功）');
    const stillThere = lease.readHolder(KEY);
    assert.equal(stillThere.purpose, '新持有者', '新持有者的登記不該被誤刪');
  });

  test('invalidate：expectedHolder 對得上時真的改名，之後可以重新 acquire', () => {
    const entry = sampleEntry();
    lease.acquire(KEY, entry);
    const snapshot = lease.readHolder(KEY);

    assert.equal(lease.invalidate(KEY, snapshot), true);
    assert.equal(lease.readHolder(KEY), null, '原路徑應已被改名，讀不到');
    assert.equal(existsSync(`${lease.holderPath(KEY)}.stale`), true, '應該留一份改名後的失效紀錄');

    const next = sampleEntry({ purpose: '重新搶到的' });
    assert.equal(lease.acquire(KEY, next).ok, true, '改名騰出路徑後，下一個搶鎖者應該成功');
  });

  test('invalidateCorrupt（S2）：登記檔壞掉（解析不出來）時把它改名作廢，之後可以重新 acquire', () => {
    mkdirSync(lease.leaseDir(KEY), { recursive: true });
    writeFileSync(lease.holderPath(KEY), '{ 這不是合法 JSON', 'utf8');

    assert.equal(lease.invalidateCorrupt(KEY), true);
    assert.equal(existsSync(lease.holderPath(KEY)), false, '壞掉的登記應該被改名搬走');
    assert.equal(existsSync(`${lease.holderPath(KEY)}.stale`), true, '應該留一份改名後的失效紀錄');

    const next = sampleEntry({ purpose: '重新搶到的' });
    assert.equal(lease.acquire(KEY, next).ok, true, '改名騰出路徑後，下一個搶鎖者應該成功');
  });

  test('invalidateCorrupt：檔案這時已經變成合法登記（別人剛好接手），不該誤刪', () => {
    const legit = sampleEntry({ purpose: '合法新持有者' });
    lease.acquire(KEY, legit);

    assert.equal(lease.invalidateCorrupt(KEY), true, '現況已是合法登記，視為成功但不動手');
    const still = lease.readHolder(KEY);
    assert.ok(still, '合法登記不該被 invalidateCorrupt 誤刪');
    assert.equal(still.purpose, '合法新持有者');
  });
});

describe('lease：其他欄位', () => {
  test('updateShellPid：身分對得上才更新，且只改 shellPid 這個欄位', () => {
    const entry = sampleEntry({ purpose: '不該被動到' });
    lease.acquire(KEY, entry);
    const identity = { pid: entry.pid, startedAt: entry.startedAt };

    lease.updateShellPid(KEY, identity, 4321);
    const after = lease.readHolder(KEY);
    assert.equal(after.shellPid, 4321);
    assert.equal(after.purpose, '不該被動到', '其餘欄位應原樣保留');

    lease.updateShellPid(KEY, { pid: entry.pid, startedAt: entry.startedAt + 1 }, 9999);
    assert.equal(lease.readHolder(KEY).shellPid, 4321, '身分不對時不該更新');
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

describe('lease：每專案一把鎖（決議 033）', () => {
  test('不同專案各搶各的：A 專案持有時，B 專案照樣搶得到，兩份登記互不覆蓋', () => {
    assert.equal(lease.acquire('proj-a', sampleEntry({ purpose: 'A' })).ok, true);
    assert.equal(lease.acquire('proj-b', sampleEntry({ purpose: 'B' })).ok, true, '跨專案不該互相擋');
    assert.equal(lease.readHolder('proj-a').purpose, 'A');
    assert.equal(lease.readHolder('proj-b').purpose, 'B');
  });

  test('同專案互相擋：同一把鍵第二次 acquire 失敗，回傳先到者', () => {
    assert.equal(lease.acquire('proj-a', sampleEntry({ purpose: '先到' })).ok, true);
    const r = lease.acquire('proj-a', sampleEntry({ purpose: '後到' }));
    assert.equal(r.ok, false);
    assert.equal(r.holder.purpose, '先到');
  });

  test('一個專案釋放、作廢，不影響別的專案的登記', () => {
    const a = sampleEntry({ purpose: 'A' });
    lease.acquire('proj-a', a);
    lease.acquire('proj-b', sampleEntry({ purpose: 'B' }));
    lease.release('proj-a', { pid: a.pid, startedAt: a.startedAt });
    assert.equal(lease.readHolder('proj-a'), null);
    assert.equal(lease.readHolder('proj-b').purpose, 'B', 'B 專案的登記不該被動到');
    lease.invalidate('proj-b', lease.readHolder('proj-b'));
    assert.equal(lease.readHolder('proj-b'), null);
    assert.equal(existsSync(`${lease.holderPath('proj-b')}.stale`), true);
    assert.equal(existsSync(`${lease.holderPath('proj-a')}.stale`), false, '作廢只動 B 的目錄');
  });

  test('listHolders：掃全部專案；舊版 machine 目錄當成一份登記；壞掉的登記標 holder 為 null；只有 .stale 的目錄不列', () => {
    lease.acquire('proj-a', sampleEntry({ purpose: 'A' }));
    lease.acquire('machine', sampleEntry({ purpose: '舊版整台一把' })); // 決議 026 的舊路徑 leases/machine/holder.json
    mkdirSync(lease.leaseDir('proj-bad'), { recursive: true });
    writeFileSync(lease.holderPath('proj-bad'), '{ 壞掉', 'utf8');
    mkdirSync(lease.leaseDir('proj-stale-only'), { recursive: true });
    writeFileSync(`${lease.holderPath('proj-stale-only')}.stale`, '{}', 'utf8');

    const all = lease.listHolders();
    const byKey = Object.fromEntries(all.map(e => [e.key, e.holder]));
    assert.deepEqual(Object.keys(byKey).sort(), ['machine', 'proj-a', 'proj-bad']);
    assert.equal(byKey['proj-a'].purpose, 'A');
    assert.equal(byKey.machine.purpose, '舊版整台一把');
    assert.equal(byKey['proj-bad'], null);
  });

  test('listHolders：leases 目錄不存在、或被一個檔案卡住（掃不了），回空陣列、不丟例外', () => {
    assert.deepEqual(lease.listHolders(), []);
    mkdirSync(join(fakeHome, '.constellation'), { recursive: true });
    writeFileSync(lease.leasesRoot(), '不是目錄', 'utf8');
    assert.deepEqual(lease.listHolders(), []);
  });

  describe('projectKey：同一個專案算出同一把鍵', () => {
    let tmp;
    beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'lease-key-')); });
    afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

    // 不叫 git：手工搭出 `git worktree add` 留下的形狀（worktree 根的 .git 是檔案，指到主 repo 的
    // .git/worktrees/<名>，裡頭的 commondir 指回共用的 .git）——signingRoot 就是讀這個形狀。
    function makeRepoWithWorktree() {
      const main = join(tmp, 'main-repo');
      const wt = join(tmp, 'wt-feature');
      mkdirSync(join(main, '.git', 'worktrees', 'wt-feature'), { recursive: true });
      writeFileSync(join(main, '.git', 'worktrees', 'wt-feature', 'commondir'), '../..\n', 'utf8');
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt-feature')}\n`, 'utf8');
      return { main, wt };
    }

    test('同一個 repo 的主工作樹與 worktree 是同一專案', () => {
      const { main, wt } = makeRepoWithWorktree();
      assert.equal(lease.projectKey(wt), lease.projectKey(main));
    });

    test('不同 repo 是不同專案', () => {
      const { main } = makeRepoWithWorktree();
      const other = join(tmp, 'other-repo');
      mkdirSync(join(other, '.git'), { recursive: true });
      assert.notEqual(lease.projectKey(other), lease.projectKey(main));
    });

    test('目錄連結（junction／symlink）與原路徑是同一專案；路徑大小寫與斜線寫法差異也收斂', () => {
      const { main } = makeRepoWithWorktree();
      const link = join(tmp, 'link-to-main');
      symlinkSync(main, link, 'junction');
      assert.equal(lease.projectKey(link), lease.projectKey(main));
      assert.equal(lease.projectKey(main.replace(/\\/g, '/')), lease.projectKey(main));
      if (process.platform === 'win32') assert.equal(lease.projectKey(main.toUpperCase()), lease.projectKey(main));
    });

    test('不是 git 目錄也算得出鍵（退回目錄本身），格式固定為 12 位十六進位', () => {
      const plain = join(tmp, 'plain');
      mkdirSync(plain, { recursive: true });
      assert.match(lease.projectKey(plain), /^[0-9a-f]{12}$/);
    });
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

  const writeHolderFile = (key, content) => {
    const dir = join(cliHome, '.constellation', 'leases', key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'holder.json'), content, 'utf8');
  };
  afterEach(() => { try { rmSync(join(cliHome, '.constellation'), { recursive: true, force: true }); } catch {} });

  test('有人持有時：list 印出持有者摘要，exit 0', () => {
    writeHolderFile('proj-a', JSON.stringify(sampleEntry({ root: 'C:/somewhere', purpose: '出貨全量驗證' }), null, 2));
    const r = runCli(['list']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /機器鎖持有中/);
    assert.match(r.stdout, /出貨全量驗證/);
    assert.match(r.stdout, /C:\/somewhere/);
  });

  test('多個專案各持有一把：list 全部列出，連舊版 leases/machine 的登記也列（決議 033）', () => {
    writeHolderFile('proj-a', JSON.stringify(sampleEntry({ root: 'C:/proj-a-root', purpose: '甲專案出貨' }), null, 2));
    writeHolderFile('proj-b', JSON.stringify(sampleEntry({ root: 'C:/proj-b-root', purpose: '乙專案出貨' }), null, 2));
    writeHolderFile('machine', JSON.stringify(sampleEntry({ root: 'C:/legacy-root', purpose: '舊版整台一把' }), null, 2));
    const r = runCli(['list']);
    assert.equal(r.status, 0);
    for (const t of [/甲專案出貨/, /乙專案出貨/, /舊版整台一把/, /C:\/proj-a-root/, /C:\/legacy-root/]) assert.match(r.stdout, t);
    assert.equal((r.stdout.match(/機器鎖持有中/g) || []).length, 3);
  });

  test('不支援的子指令：印用法、exit 1', () => {
    const r = runCli(['stop']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /用法：/);
  });

  test('登記檔存在但壞掉（S2）：照實說「讀不出來」，不能講成「沒有人持有」', () => {
    writeHolderFile('proj-a', ''); // 0 位元組
    const r = runCli(['list']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /讀不出來/, '應照實講壞掉，不是空手放行成「沒有人持有」');
    assert.doesNotMatch(r.stdout, /目前沒有人持有機器鎖/);
  });

  test('一份壞掉、一份正常：兩份都要講到，壞的不遮住好的', () => {
    writeHolderFile('proj-a', '');
    writeHolderFile('proj-b', JSON.stringify(sampleEntry({ purpose: '乙專案出貨' }), null, 2));
    const r = runCli(['list']);
    assert.match(r.stdout, /讀不出來/);
    assert.match(r.stdout, /乙專案出貨/);
  });
});
