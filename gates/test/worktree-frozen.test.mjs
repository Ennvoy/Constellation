// gates/test/worktree-frozen.test.mjs — 三個防護缺陷的回歸（決議 030）：
//   一、簽章綁路徑誤判：done 票證據簽章原本綁「worktree 自己的根目錄」，同一份票在另一個 worktree
//       （或主工作樹）驗簽就判不符。改綁主 repo 根（從 .git 檔的 commondir 解出，所有 worktree 共用），
//       並相容舊簽章（舊算法＝呼叫端給的根）。
//   二、凍結守衛漏 Bash／PowerShell：close-gate.mjs 只掛 Edit|Write，經 shell 寫檔可改凍結檔。
//       pre-tool-use.mjs 改為對 shell 指令做同一套凍結判斷（常見寫檔形態，唯讀指令不誤擋）。
//   三、合併後凍結名單變少：design-frozen.json 的 frozen 陣列在 commit 時少掉路徑、卻沒有同一個
//       commit 新增的 unfreeze 紀錄 → commit 守門擋下並列出被刪的路徑。
// 全部黑箱 spawn pre-tool-use.mjs（與 pre-tool-use.test.mjs 同款），git 操作都在拋棄式暫存 repo 裡做。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

const GATES = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(GATES, 'pre-tool-use.mjs');
const RUNNER = join(GATES, 'verify-runner.mjs');
const COMMIT_GATE = join(GATES, 'commit-gate.mjs');

const tmpDirs = [];
const mk = prefix => { const d = mkdtempSync(join(tmpdir(), prefix)); tmpDirs.push(d); return d; };
after(() => {
  for (const d of tmpDirs.reverse()) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

function initRepo(prefix) {
  const dir = mk(prefix);
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  spawnSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
  mkdirSync(join(dir, '.constellation', 'tickets'), { recursive: true });
  writeFileSync(join(dir, '.constellation', 'config.json'), JSON.stringify({ commands: {} }), 'utf8');
  return dir;
}

function run(input, extraEnv = {}) {
  const r = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...extraEnv },
  });
  return { status: r.status, stderr: r.stderr || '' };
}

// ───────────────────────────── 一、簽章跨 worktree ─────────────────────────────
// 舊算法的獨立對照（與 close-gate.test.mjs 的 sign() 同款，不 import evidence.cjs）。
const SEP = '\u0001';
const relOf = p => String(p).replace(/\\/g, '/').match(/\.constellation\/tickets\/[^/]+\.md$/i)[0];
const legacyToken = cwd => resolve(cwd).toLowerCase().replace(/\\/g, '/');
const sign = (secret, ts, rel, cmds, last, root) =>
  createHmac('sha256', secret).update([ts, rel, cmds, last, root].join(SEP), 'utf8').digest('hex');

describe('一、done 票簽章與 worktree 路徑脫鉤（決議 030 第 1 項）', () => {
  const SECRET = 'test-secret-worktree-sig';
  let home, mainRepo, wt;

  before(() => {
    home = mk('wtsig-home-');
    mkdirSync(join(home, '.constellation'), { recursive: true });
    writeFileSync(join(home, '.constellation', 'secret'), SECRET, 'utf8');
    mainRepo = initRepo('wtsig-main-');
    writeFileSync(join(mainRepo, 'ok.mjs'), "console.log('ok');\n", 'utf8');
    git(mainRepo, 'add', '-A');
    git(mainRepo, 'commit', '-q', '-m', 'init');
    wt = join(mk('wtsig-wtparent-'), 'wt');
    git(mainRepo, 'worktree', 'add', '-q', '--detach', wt);
    mkdirSync(join(wt, '.constellation', 'tickets'), { recursive: true }); // 空目錄不進 git，worktree 端補建
  });
  after(() => { try { git(mainRepo, 'worktree', 'remove', '--force', wt); } catch {} });
  // 前一案失敗時不會走到自己的 reset，這裡統一清 staging，避免殘留連坐下一案。
  beforeEach(() => { git(mainRepo, 'reset', '-q'); git(wt, 'reset', '-q'); });

  const envHome = () => ({ USERPROFILE: home, HOME: home });
  const ticketBody = (id, dir) => [
    '---', 'status: done', '---', `# ${id} demo`, '',
    '## 驗收條件', '- [x] 條件一', '',
    '## 決議記錄', '',
    '## 驗證指令', `- \`node "${join(dir, 'ok.mjs').replace(/\\/g, '/')}"\``, '',
    '## 驗證證據（關票時由 runner 寫入）', '',
  ].join('\n');
  function signViaRunner(repoDir, ticket) {
    const r = spawnSync(process.execPath, [RUNNER, '--ticket', ticket, '--scope', 'ticket', '--cwd', repoDir], {
      env: { ...process.env, ...envHome() }, encoding: 'utf8', timeout: 60_000,
    });
    if (r.status !== 0) throw new Error(`fixture 簽章失敗（exit ${r.status}）：${r.stderr}`);
  }
  const commitIn = dir => run({ tool_name: 'Bash', cwd: dir, tool_input: { command: 'git commit -m "x"' } }, envHome());
  function copyAndStage(fromTicket, toRepo) {
    const dest = join(toRepo, '.constellation', 'tickets', fromTicket.split(/[\\/]/).pop());
    copyFileSync(fromTicket, dest);
    git(toRepo, 'add', dest);
    return dest;
  }

  test('主工作樹 runner 簽的票，原封搬進 worktree 後在 worktree commit：放行（403 情境）', () => {
    const t = join(mainRepo, '.constellation', 'tickets', 'T-701-main.md');
    writeFileSync(t, ticketBody('T-701', mainRepo), 'utf8');
    signViaRunner(mainRepo, t);
    copyAndStage(t, wt);
    const r = commitIn(wt);
    assert.equal(r.status, 0, `應放行，實際 exit ${r.status}｜${r.stderr.slice(0, 300)}`);
  });

  test('worktree 內 runner 簽的票，原封搬回主工作樹 commit：放行', () => {
    const t = join(wt, '.constellation', 'tickets', 'T-702-wt.md');
    writeFileSync(t, ticketBody('T-702', wt), 'utf8');
    signViaRunner(wt, t);
    copyAndStage(t, mainRepo);
    const r = commitIn(mainRepo);
    assert.equal(r.status, 0, `應放行，實際 exit ${r.status}｜${r.stderr.slice(0, 300)}`);
  });

  test('舊算法簽章（綁 worktree 自己的根）在同一個 worktree 驗簽：相容放行', () => {
    const t = join(wt, '.constellation', 'tickets', 'T-703-legacy.md');
    const ts = new Date().toISOString();
    const CMD = 'node -e "console.log(1)"';
    const sig = sign(SECRET, ts, relOf(t), CMD, '1', legacyToken(git(wt, 'rev-parse', '--show-toplevel').trim()));
    writeFileSync(t, [
      '---', 'status: done', '---', '# T-703', '', '## 驗收條件', '- [x] 條件一', '',
      '## 驗證證據（關票時由 runner 寫入）', `- **${ts}**`, `  - \`${CMD}\`（exit 0）`,
      '    ```', '    1', '    ```', `  - sig: ${sig}`, '',
    ].join('\n'), 'utf8');
    git(wt, 'add', t);
    const r = commitIn(wt);
    assert.equal(r.status, 0, `應放行，實際 exit ${r.status}｜${r.stderr.slice(0, 300)}`);
  });

  test('反例：簽章綁的是另一個 repo（跨專案重放），在 worktree 仍擋下', () => {
    const other = initRepo('wtsig-other-');
    writeFileSync(join(other, 'ok.mjs'), "console.log('ok');\n", 'utf8');
    const t = join(other, '.constellation', 'tickets', 'T-704-other.md');
    writeFileSync(t, ticketBody('T-704', other), 'utf8');
    signViaRunner(other, t);
    copyAndStage(t, wt);
    const r = commitIn(wt);
    assert.equal(r.status, 2, `應擋下，實際 exit ${r.status}`);
    assert.match(r.stderr, /驗簽失敗/);
  });
});

// ───────────────────────────── 二、shell 寫凍結檔 ─────────────────────────────
describe('二、Bash／PowerShell 寫入凍結檔一律擋下、唯讀不誤擋（決議 030 第 2 項）', () => {
  let repo, other;
  before(() => {
    repo = initRepo('frzsh-');
    mkdirSync(join(repo, 'src', 'pages'), { recursive: true });
    writeFileSync(join(repo, 'src', 'Frozen.tsx'), 'export {}\n', 'utf8');
    writeFileSync(join(repo, 'src', 'pages', 'page.tsx'), 'export {}\n', 'utf8');
    writeFileSync(join(repo, 'src', 'Other.tsx'), 'export {}\n', 'utf8');
    writeFileSync(join(repo, '.constellation', 'design-frozen.json'), JSON.stringify({
      frozen: ['src/Frozen.tsx', 'src/pages/page.tsx'], log: [],
    }), 'utf8');
    other = initRepo('frzsh-nofrozen-');
    writeFileSync(join(other, 'Frozen.tsx'), 'x', 'utf8');
  });

  const sh = (command, cwd = repo, tool = 'Bash') => run({ tool_name: tool, cwd, tool_input: { command } });
  const ps = (command, cwd = repo) => sh(command, cwd, 'PowerShell');
  const blocked = (r, label) => {
    assert.equal(r.status, 2, `${label}：應擋下，實際 exit ${r.status}｜${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /凍結/, `${label}：訊息應講明是凍結檔`);
  };
  const passed = (r, label) => assert.equal(r.status, 0, `${label}：應放行，實際 exit ${r.status}｜${r.stderr.slice(0, 300)}`);

  const BLOCK_CASES = [
    ['bash 重導向 >', () => sh('echo x > src/Frozen.tsx')],
    ['bash 附加 >>（./ 前綴）', () => sh('echo x >> ./src/Frozen.tsx')],
    ['2> 也算寫檔', () => sh('node a.js 2> src/Frozen.tsx')],
    ['PowerShell Set-Content -Path', () => ps('Set-Content -Path src/Frozen.tsx -Value "x"')],
    ['PowerShell 讀改寫回（Get-Content | Set-Content）', () => ps("(Get-Content src\\Frozen.tsx) -replace 'a','b' | Set-Content src\\Frozen.tsx")],
    ['PowerShell Out-File', () => ps("'x' | Out-File -FilePath src/Frozen.tsx -Encoding utf8")],
    ['PowerShell Add-Content', () => ps('Add-Content src/Frozen.tsx "x"')],
    ['cp 目的地是凍結檔', () => sh('cp src/Other.tsx src/Frozen.tsx')],
    ['Copy-Item -Destination 是凍結檔', () => ps('Copy-Item src/Other.tsx -Destination src/Frozen.tsx -Force')],
    ['cp 目的地是目錄（同名覆蓋凍結檔）', () => sh('cp /tmp/x/Frozen.tsx src/')],
    ['mv 把凍結檔搬走', () => sh('mv src/Frozen.tsx src/Old.tsx')],
    ['Move-Item 目的地是凍結檔', () => ps('Move-Item src/Other.tsx src/Frozen.tsx')],
    ['rm 凍結檔', () => sh('rm -f src/Frozen.tsx')],
    ['sed -i', () => sh("sed -i 's/a/b/' src/Frozen.tsx")],
    ['tee', () => sh('echo x | tee -a src/Frozen.tsx')],
    ['git checkout -- 凍結檔', () => sh('git checkout HEAD~1 -- src/Frozen.tsx')],
    ['git restore 凍結檔', () => sh('git restore src/Frozen.tsx')],
    ['cd 進子目錄後重導向', () => sh('cd src && echo x > Frozen.tsx')],
    ['絕對路徑、cwd 在別處', () => sh(`echo x > "${join(repo, 'src', 'Frozen.tsx').replace(/\\/g, '/')}"`, tmpdir())],
    ['大小寫與反斜線不同', () => ps('Set-Content .\\SRC\\frozen.tsx "x"')],
    ['路徑含方括號（Next.js 動態路由風格）的 -LiteralPath', () => ps("Set-Content -LiteralPath 'src/pages/page.tsx' -Value x")],
  ];
  for (const [label, fn] of BLOCK_CASES) test(`擋：${label}`, () => blocked(fn(), label));

  const PASS_CASES = [
    ['cat 讀凍結檔', () => sh('cat src/Frozen.tsx')],
    ['grep 讀凍結檔', () => sh('grep -n export src/Frozen.tsx')],
    ['Get-Content 讀凍結檔', () => ps('Get-Content src/Frozen.tsx')],
    ['git diff 凍結檔', () => sh('git diff src/Frozen.tsx')],
    ['cp 凍結檔當來源', () => sh('cp src/Frozen.tsx /tmp/copy.tsx')],
    ['Copy-Item 凍結檔當來源', () => ps('Copy-Item -Path src/Frozen.tsx -Destination $env:TEMP/copy.tsx')],
    ["sed -n 只讀", () => sh("sed -n '1,5p' src/Frozen.tsx")],
    ['git restore --staged 只動 index', () => sh('git restore --staged src/Frozen.tsx')],
    ['寫非凍結檔', () => sh('echo x > src/Other.tsx')],
    ['2>&1 與 tee 寫非凍結檔', () => sh('node build.js 2>&1 | tee build-out.txt')],
    ['重導向到 /dev/null 與 $null', () => ps('Get-Content src/Frozen.tsx > $null; ls 2>/dev/null')],
    ['寫凍結名單本身（解凍要能做）', () => sh('echo {} > .constellation/design-frozen.json')],
    ['指令字串裡只是提到凍結檔路徑', () => sh('git commit -m "fix src/Frozen.tsx > layout"')],
    ['沒有凍結名單的 repo', () => sh('echo x > Frozen.tsx', other)],
  ];
  for (const [label, fn] of PASS_CASES) test(`放行：${label}`, () => passed(fn(), label));
});

// ───────────────────────────── 三、合併後凍結名單變少 ─────────────────────────────
describe('三、commit 時 frozen 少掉路徑卻沒有新 unfreeze 紀錄 → 擋下（決議 030 第 3 項）', () => {
  const FROZEN_REL = join('.constellation', 'design-frozen.json');
  const writeFrozen = (dir, frozen, log = []) =>
    writeFileSync(join(dir, FROZEN_REL), JSON.stringify({ frozen, log }, null, 2) + '\n', 'utf8');
  const commitCheck = dir => run({ tool_name: 'Bash', cwd: dir, tool_input: { command: 'git commit -m "x"' } });
  const OLD_UNFREEZE = { path: 'src/B.tsx', action: 'unfreeze', ticket: 'T-1', reason: 'old', at: '2026-01-01' };
  const OLD_REFREEZE = { path: 'src/B.tsx', action: 'refreeze', ticket: 'T-1', reason: 'old', at: '2026-01-02' };

  function baseRepo() {
    const dir = initRepo('frzshrink-');
    writeFrozen(dir, ['src/A.tsx', 'src/B.tsx'], [OLD_UNFREEZE, OLD_REFREEZE]);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    return dir;
  }

  test('frozen 少了一筆、log 沒有新增 unfreeze：擋下並列出被刪的路徑', () => {
    const dir = baseRepo();
    writeFrozen(dir, ['src/A.tsx'], [OLD_UNFREEZE, OLD_REFREEZE]);
    git(dir, 'add', FROZEN_REL);
    const r = commitCheck(dir);
    assert.equal(r.status, 2, `應擋下，實際 exit ${r.status}｜${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /src\/B\.tsx/);
    assert.match(r.stderr, /unfreeze/);
  });

  test('frozen 少了一筆、log 只有舊的 unfreeze（HEAD 就有）：仍擋下', () => {
    const dir = baseRepo();
    writeFrozen(dir, ['src/A.tsx'], [OLD_UNFREEZE]); // 甚至刪掉舊 refreeze，舊 unfreeze 也不算數
    git(dir, 'add', FROZEN_REL);
    assert.equal(commitCheck(dir).status, 2);
  });

  test('frozen 少了一筆、同一個 commit 新增對應 unfreeze：放行', () => {
    const dir = baseRepo();
    writeFrozen(dir, ['src/A.tsx'], [OLD_UNFREEZE, OLD_REFREEZE,
      { path: 'src\\b.tsx', action: 'unfreeze', ticket: 'T-2', reason: '換真資料', at: '2026-10-01' }]);
    git(dir, 'add', FROZEN_REL);
    const r = commitCheck(dir);
    assert.equal(r.status, 0, `應放行，實際 exit ${r.status}｜${r.stderr.slice(0, 300)}`);
  });

  test('只新增凍結路徑：放行', () => {
    const dir = baseRepo();
    writeFrozen(dir, ['src/A.tsx', 'src/B.tsx', 'src/C.tsx'], [OLD_UNFREEZE, OLD_REFREEZE]);
    git(dir, 'add', FROZEN_REL);
    assert.equal(commitCheck(dir).status, 0);
  });

  test('整份 design-frozen.json 移出（出貨歸檔）：放行', () => {
    const dir = baseRepo();
    git(dir, 'rm', '-q', FROZEN_REL);
    assert.equal(commitCheck(dir).status, 0);
  });

  test('git 原生 pre-commit 入口同樣擋下', () => {
    const dir = baseRepo();
    writeFrozen(dir, ['src/A.tsx'], [OLD_UNFREEZE, OLD_REFREEZE]);
    git(dir, 'add', FROZEN_REL);
    const r = spawnSync(process.execPath, [COMMIT_GATE, '--precommit'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 1, `應擋下，實際 exit ${r.status}｜${r.stderr}`);
    assert.match(r.stderr, /src\/B\.tsx/);
  });

  test('真實情境：兩支分支合併衝突、人工解衝突時漏掉一筆 frozen → 結束合併的 commit 擋下（406 成因 B）', () => {
    const dir = baseRepo();
    git(dir, 'checkout', '-q', '-b', 'side');
    writeFrozen(dir, ['src/A.tsx', 'src/B.tsx', 'src/C.tsx'],
      [OLD_UNFREEZE, OLD_REFREEZE, { path: 'src/C.tsx', action: 'freeze', ticket: 'T-3', at: '2026-10-01' }]);
    git(dir, 'commit', '-q', '-am', 'side adds C');
    git(dir, 'checkout', '-q', 'main');
    writeFrozen(dir, ['src/A.tsx', 'src/B.tsx', 'src/D.tsx'],
      [OLD_UNFREEZE, OLD_REFREEZE, { path: 'src/D.tsx', action: 'freeze', ticket: 'T-4', at: '2026-10-01' }]);
    git(dir, 'commit', '-q', '-am', 'main adds D');
    const m = spawnSync('git', ['-C', dir, 'merge', 'side', '-m', 'merge'], { encoding: 'utf8' });
    assert.notEqual(m.status, 0, 'fixture 前提：兩邊改同一段應該衝突');
    // 人工解衝突：log 兩邊都留，frozen 卻漏了 src/B.tsx
    writeFrozen(dir, ['src/A.tsx', 'src/C.tsx', 'src/D.tsx'], [OLD_UNFREEZE, OLD_REFREEZE,
      { path: 'src/D.tsx', action: 'freeze', ticket: 'T-4', at: '2026-10-01' },
      { path: 'src/C.tsx', action: 'freeze', ticket: 'T-3', at: '2026-10-01' }]);
    git(dir, 'add', FROZEN_REL);
    const r = commitCheck(dir);
    assert.equal(r.status, 2, `應擋下，實際 exit ${r.status}｜${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /src\/B\.tsx/);
    assert.doesNotMatch(r.stderr, /src\/C\.tsx|src\/D\.tsx/);
  });
});
