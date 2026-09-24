// gates/test/session-start.test.mjs — 對抗審查 should-fix：P16 把 resolveRepoRoot 從呼叫兩次
// （buildSummary 內部一次、ensurePrecommit 一次）改成只解析一次、buildSummary／ensurePrecommit
// 共用同一個 root，這個改動完全沒有回歸網。session-start.mjs 檔尾無條件掛 stdin（沒有
// import.meta.url 守衛），只能黑箱 spawn 驗證最基本的兩個情境：非 Constellation 專案靜默放行、
// Constellation 專案正常注入且 pre-commit 只裝一次。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'session-start.mjs');

let nonProj, proj;

before(() => {
  nonProj = mkdtempSync(join(tmpdir(), 'ss-nonproj-'));

  proj = mkdtempSync(join(tmpdir(), 'ss-proj-'));
  spawnSync('git', ['init', '-q'], { cwd: proj });
  spawnSync('git', ['config', 'user.email', 'a@b.c'], { cwd: proj });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: proj });
  mkdirSync(join(proj, '.constellation', 'tickets'), { recursive: true });
  writeFileSync(join(proj, '.constellation', 'tickets', 'T-001-demo.md'), [
    '---', 'status: in-progress', '---', '# T-001 demo', '',
    '## 驗收條件', '- [x] 條件一', '- [ ] 條件二', '',
  ].join('\n'), 'utf8');
});

after(() => {
  for (const d of [nonProj, proj]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

function run(cwd) {
  const r = spawnSync(process.execPath, [GATE], { input: JSON.stringify({ cwd }), cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '' };
}

describe('session-start：對抗審查 should-fix——resolveRepoRoot 只解析一次的回歸網', () => {
  test('非 Constellation 專案：靜默 exit 0，不輸出任何東西', () => {
    const r = run(nonProj);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', '非 Constellation 專案不該有任何 stdout');
  });

  test('Constellation 專案：注入 additionalContext，且第一次執行順便裝上 pre-commit 兜底', () => {
    const r = run(proj);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /T-001/, '摘要應含票名/票號');
    assert.match(ctx, /pre-commit/, '第一次執行應提到剛裝上 pre-commit 兜底');
    assert.ok(existsSync(join(proj, '.git', 'hooks', 'pre-commit')), 'pre-commit hook 檔案應已存在');
  });

  test('同一個專案重跑第二次：pre-commit 已裝過，不重複提示、也不報錯', () => {
    const r = run(proj);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /已為本 repo 裝上/, '裝過一次之後不該再提示剛裝上');
  });
});
