// gates/test/pre-tool-use.test.mjs — P18 回歸：非 git 指令不再載入 git 守門／commit 守門，
// 但兩道閘門原本的判定結果（含 tool_input／toolInput 兩種鍵名）必須一字不差地維持。
// pre-tool-use.mjs 本身沒有 export 的純函式（stdin 導向），黑箱 spawn 驗證。
//
// 對抗審查 should-fix：commit-gate 沒有 .constellation 專案就 fail-open放行，「真繞過 commit」那個
// 案例原本沒帶 cwd，靠 commitGateCheck 內部 fallback 到 process.cwd()——測試能不能過因此取決於跑
// 測試時人站在哪個目錄（在有 .constellation 的目錄下才會過），還混到真實 repo 的 staged 狀態。改法：
// 造一個獨立的暫存 git repo（有 .constellation），commit 相關案例一律明確帶 cwd 指向它。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pre-tool-use.mjs');

let repo;

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'ptu-test-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  spawnSync('git', ['config', 'user.email', 'a@b.c'], { cwd: repo });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  mkdirSync(join(repo, '.constellation'), { recursive: true });
});

after(() => {
  rmSync(repo, { recursive: true, force: true });
});

function run(input) {
  const r = spawnSync(process.execPath, [GATE], { input: JSON.stringify(input), encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr || '' };
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

  test('sed -n 這類含 -n 但非 commit 繞過的 git 指令放行（P4 對應行為，經 dispatcher 整合驗證一次）', () => {
    const r = run({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'git log -1 && sed -n 1,5p a.md' } });
    assert.equal(r.status, 0);
  });

  test('唯讀 git 指令放行', () => {
    const r = run({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'git status && git log -3' } });
    assert.equal(r.status, 0);
  });
});
