// gates/test/install-hooks.test.mjs — 對抗審查 should-fix：install-hooks.mjs 的 merge-hooks 合併
// 邏輯（install.ps1 抽出來的真檔案，見 P23）原本完全沒有自動化回歸，只在整合驗證時人工核對過。
// mergeHooks 是純函式（讀寫指定的 targetPath，不碰真正的 ~/.claude/settings.json），直接 import 呼叫。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeHooks } from '../install-hooks.mjs';

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
