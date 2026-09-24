// gates/test/install-hooks.test.mjs — 對抗審查 should-fix：install-hooks.mjs 的 merge-hooks 合併
// 邏輯（install.ps1 抽出來的真檔案，見 P23）原本完全沒有自動化回歸，只在整合驗證時人工核對過。
// mergeHooks 是純函式（讀寫指定的 targetPath，不碰真正的 ~/.claude/settings.json），直接 import 呼叫。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeHooks, setWorktreeBaseRef } from '../install-hooks.mjs';

let dir, target, fragment;
const ROOT = 'C:\\fake-constellation-root';

function writeFragment(events) {
  writeFileSync(fragment, JSON.stringify({ hooks: events }), 'utf8');
}
function ownEntry(scriptName) {
  return { hooks: [{ type: 'command', command: `node "${ROOT}\\gates\\${scriptName}.mjs"` }] };
}
function readTarget() {
  return JSON.parse(readFileSync(target, 'utf8'));
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ih-test-'));
  target = join(dir, 'settings.json');
  fragment = join(dir, 'fragment.json');
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('install-hooks：merge-hooks——安裝、重跑冪等、撤事件、卸載', () => {
  test('全新安裝：target 不存在，合併後自家項數量與 target 內容正確', () => {
    writeFileSync(target, '', 'utf8'); // 不存在或空檔都要能處理（readJson 的 fallback）
    writeFragment({ SessionStart: [ownEntry('session-start')], PreToolUse: [ownEntry('pre-tool-use')] });
    const r = mergeHooks(target, fragment, 'merge', ROOT);
    assert.equal(r.ownCount, 2, '新增的自家項數量');
    assert.equal(r.removedCount, 0, '第一次安裝沒有舊項可拔');
    const t = readTarget();
    assert.equal(t.hooks.SessionStart.length, 1);
    assert.equal(t.hooks.PreToolUse.length, 1);
  });

  test('保留使用者原有的其他項目：非自家 hook 不被動到', () => {
    writeFileSync(target, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-own-hook' }] }] } }), 'utf8');
    writeFragment({ SessionStart: [ownEntry('session-start')] });
    mergeHooks(target, fragment, 'merge', ROOT);
    const t = readTarget();
    assert.equal(t.hooks.SessionStart.length, 2, '使用者原有的 + 新掛的自家項');
    assert.ok(t.hooks.SessionStart.some((e) => e.hooks[0].command === 'echo user-own-hook'), '使用者原有項目要保留');
  });

  test('重跑冪等：同一份 fragment 再跑一次，自家項不重複累加', () => {
    writeFileSync(target, '', 'utf8');
    writeFragment({ SessionStart: [ownEntry('session-start')] });
    mergeHooks(target, fragment, 'merge', ROOT);
    const r2 = mergeHooks(target, fragment, 'merge', ROOT);
    assert.equal(r2.removedCount, 1, '第二次跑要先拔掉第一次裝的那一個');
    assert.equal(r2.ownCount, 1, '拔完再裝回同樣一個，不累加');
    const t = readTarget();
    assert.equal(t.hooks.SessionStart.length, 1, '冪等：跑幾次都只有一個');
  });

  test('repo 搬家重裝：舊路徑的自家項也認得出來並替換成新路徑', () => {
    const OLD_ROOT = 'C:\\old-path';
    writeFileSync(target, '', 'utf8');
    writeFragment({ SessionStart: [ownEntry('session-start')] });
    mergeHooks(target, fragment, 'merge', OLD_ROOT); // 先用舊路徑裝一次
    const r = mergeHooks(target, fragment, 'merge', ROOT); // 搬家後用新路徑重跑
    assert.equal(r.removedCount, 1, '舊路徑的登記要被認出並拔掉');
    const t = readTarget();
    assert.equal(t.hooks.SessionStart.length, 1);
    assert.match(t.hooks.SessionStart[0].hooks[0].command, /fake-constellation-root/, '殘留的應是新路徑');
  });

  test('撤事件：fragment 不再提到的舊事件（例如撤掉的 SessionEnd）要被清乾淨', () => {
    writeFileSync(target, '', 'utf8');
    writeFragment({ SessionStart: [ownEntry('session-start')], SessionEnd: [ownEntry('serve')] });
    mergeHooks(target, fragment, 'merge', ROOT);
    writeFragment({ SessionStart: [ownEntry('session-start')] }); // 這次 fragment 不再提 SessionEnd
    mergeHooks(target, fragment, 'merge', ROOT);
    const t = readTarget();
    assert.equal(t.hooks.SessionEnd, undefined, '不再提到的事件應整個被刪掉，不留空陣列');
  });

  test('卸載：mode=uninstall 只拔自家項，不附加任何內容，且保留使用者原有項目', () => {
    writeFileSync(target, JSON.stringify({ hooks: { SessionStart: [ownEntry('session-start'), { hooks: [{ type: 'command', command: 'echo user-own-hook' }] }] } }), 'utf8');
    writeFragment({ SessionStart: [ownEntry('session-start')] });
    const r = mergeHooks(target, fragment, 'uninstall', ROOT);
    assert.equal(r.removedCount, 1);
    assert.equal(r.ownCount, 0, 'uninstall 模式不附加');
    const t = readTarget();
    assert.equal(t.hooks.SessionStart.length, 1);
    assert.equal(t.hooks.SessionStart[0].hooks[0].command, 'echo user-own-hook');
  });
});

// ---------------------------------------------------------------------------
// setWorktreeBaseRef（P1）：使用者沒設過 worktree.baseRef 才寫成 "head"，用頂層
// _constellation 旗標記自己寫過哪筆，卸載只憑旗標移除。同一個 mkdtemp 目錄下開
// 一個獨立檔案，不跟上面 merge-hooks 的 target 共用。
// ---------------------------------------------------------------------------
let wtTarget;

function readWT() {
  return JSON.parse(readFileSync(wtTarget, 'utf8'));
}

describe('install-hooks：worktree-baseref——P1 worker 工作區基底', () => {
  before(() => {
    wtTarget = join(dir, 'wt-settings.json');
  });

  test('未設過：worktree.baseRef 不存在時寫入 "head"，並在頂層打上 _constellation 旗標', () => {
    writeFileSync(wtTarget, JSON.stringify({ hooks: { SessionStart: [] } }), 'utf8');
    const r = setWorktreeBaseRef(wtTarget, 'merge');
    assert.equal(r.action, 'written');
    const t = readWT();
    assert.equal(t.worktree.baseRef, 'head');
    assert.equal(t._constellation.worktreeBaseRef, true);
    assert.deepEqual(t.hooks, { SessionStart: [] }, '不動其他既有內容');
  });

  test('已設過（使用者自己的值）：不論是什麼值都不動，也不補旗標', () => {
    writeFileSync(wtTarget, JSON.stringify({ worktree: { baseRef: 'fresh' } }), 'utf8');
    const r = setWorktreeBaseRef(wtTarget, 'merge');
    assert.equal(r.action, 'already-set');
    const t = readWT();
    assert.equal(t.worktree.baseRef, 'fresh', '使用者自己設的值不能被改');
    assert.equal(t._constellation, undefined, '不是我們寫的，不該打旗標');
  });

  test('重跑冪等：裝過一次之後再跑，值與旗標都不再變動', () => {
    writeFileSync(wtTarget, '{}', 'utf8');
    setWorktreeBaseRef(wtTarget, 'merge');
    const r2 = setWorktreeBaseRef(wtTarget, 'merge');
    assert.equal(r2.action, 'already-set', '第二次已經有值了，只是那個值是我們自己第一次寫的');
    const t = readWT();
    assert.equal(t.worktree.baseRef, 'head');
    assert.equal(t._constellation.worktreeBaseRef, true);
  });

  test('卸載：旗標在才刪；刪完 worktree／_constellation 變空殼也一併清掉，不留空物件', () => {
    writeFileSync(wtTarget, '{}', 'utf8');
    setWorktreeBaseRef(wtTarget, 'merge');
    const r = setWorktreeBaseRef(wtTarget, 'uninstall');
    assert.equal(r.action, 'removed');
    const t = readWT();
    assert.equal(t.worktree, undefined, '刪完沒有其他子鍵，整個 worktree 一併拿掉');
    assert.equal(t._constellation, undefined, '旗標也拿掉，不留空殼');
  });

  test('卸載：使用者自己設的值（沒有我們的旗標）不能被移除', () => {
    writeFileSync(wtTarget, JSON.stringify({ worktree: { baseRef: 'fresh' } }), 'utf8');
    const r = setWorktreeBaseRef(wtTarget, 'uninstall');
    assert.equal(r.action, 'skip');
    const t = readWT();
    assert.equal(t.worktree.baseRef, 'fresh', '不是我們寫的，卸載不能動');
  });

  test('卸載：worktree 底下還有使用者自己加的其他子鍵時，只拔 baseRef，保留其他子鍵', () => {
    writeFileSync(wtTarget, JSON.stringify({
      worktree: { baseRef: 'head', sparsePaths: ['a'] },
      _constellation: { worktreeBaseRef: true },
    }), 'utf8');
    const r = setWorktreeBaseRef(wtTarget, 'uninstall');
    assert.equal(r.action, 'removed');
    const t = readWT();
    assert.equal(t.worktree.baseRef, undefined);
    assert.deepEqual(t.worktree.sparsePaths, ['a'], '使用者自己加的其他 worktree 子鍵要保留');
  });

  // 對抗複審 M1：卸載時不能連使用者裝完後自己改過的值也一起刪掉——旗標只證明「我們裝過」，
  // 不證明「現在這個值還是我們寫的那個」。
  test('卸載：旗標在，但值已被使用者改成別的（不是我們寫的 "head"），只刪旗標，不動使用者改過的值', () => {
    writeFileSync(wtTarget, JSON.stringify({
      worktree: { baseRef: 'fresh' },
      _constellation: { worktreeBaseRef: true },
    }), 'utf8');
    const r = setWorktreeBaseRef(wtTarget, 'uninstall');
    assert.equal(r.action, 'removed');
    const t = readWT();
    assert.equal(t.worktree.baseRef, 'fresh', '使用者改過的值不能被卸載連坐刪掉');
    assert.equal(t._constellation, undefined, '我們自己的旗標仍要拿掉');
  });

  // 對抗複審 M1 同類問題：使用者裝完後把 baseRef 整個刪掉（想退回官方預設）、旗標沒動，
  // 重裝時鍵不在但旗標在——這是使用者主動退出，不是「從未裝過」，不該被當成全新安裝重新寫回。
  test('重裝：旗標在但值已被使用者刪掉（想退回官方預設），視為主動退出，不重新寫回 head', () => {
    writeFileSync(wtTarget, JSON.stringify({ _constellation: { worktreeBaseRef: true } }), 'utf8');
    const r = setWorktreeBaseRef(wtTarget, 'merge');
    assert.equal(r.action, 'skip');
    const t = readWT();
    assert.equal(t.worktree, undefined, '不該被重新寫回 head');
    assert.equal(t._constellation.worktreeBaseRef, true, '旗標留著，避免下次又被誤判成全新安裝');
  });
});
