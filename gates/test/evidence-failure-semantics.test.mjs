// gates/test/evidence-failure-semantics.test.mjs — P14 第三步：evidence.cjs 失效語義。
// 把整個 gates/ 複製到暫存目錄，分別造三種壞法（檔案不見／執行時丟例外／少了一個匯出），驗證：
//   - 跟 evidence.cjs 完全無關的防線（凍結守衛、secrets、git push --force、一般編輯）不受影響——
//     close-gate.mjs／commit-gate.mjs 只在真的碰到 done 票時才 createRequire 載入該模組，模組壞掉
//     不該連坐擋下或連坐放行其他判定。
//   - 唯一受影響的是 done 票稽核（關票／commit 兩條路徑），且必須 fail-closed（擋下，不是放行），
//     訊息含「簽章模組」——讓人一看就知道是模組故障，不是這張票的證據有問題（P14 對抗審查 must-fix）。
// 「合法 done 票」的證據用真正的（未壞掉的）gates/verify-runner.mjs 簽出來，證明「這張票在模組正常時
// 會過關，只是因為模組壞了才被擋下」，不是隨便找一張本來就會被擋的票來測。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, copyFileSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GATES_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_RUNNER = join(GATES_SRC, 'verify-runner.mjs'); // 沒壞掉的本尊，只用來簽「合法」證據 fixture

// 把 gates/ 頂層檔案（不含 test/ 子目錄）複製一份到暫存目錄，回傳新目錄路徑——三支壞法各自在
// 自己的複本裡覆寫 evidence.cjs，互不干擾，也不會動到真正的 gates/。
function copyGates() {
  const dest = mkdtempSync(join(tmpdir(), 'evfail-gates-'));
  for (const name of readdirSync(GATES_SRC)) {
    if (name === 'test') continue;
    const src = join(GATES_SRC, name);
    if (statSync(src).isDirectory()) continue; // gates/ 目前頂層只有檔案＋test/ 一個子目錄
    copyFileSync(src, join(dest, name));
  }
  return dest;
}

const BROKEN = {
  missing: (gatesDir) => { try { rmSync(join(gatesDir, 'evidence.cjs')); } catch {} },
  throws: (gatesDir) => writeFileSync(join(gatesDir, 'evidence.cjs'), [
    "'use strict';",
    "// 測試用壞版本：checkLatestEvidence 執行時丟例外。",
    "function checkLatestEvidence() { throw new Error('boom：evidence.cjs 故意壞掉（測試用）'); }",
    "module.exports = {",
    "  SECRET_PATH: '(broken)', readSecret: () => null, ticketRelPath: (p) => p,",
    "  repoRootToken: (p) => p, computeSignature: () => '', COMMAND_LINE_RE: /x/, checkLatestEvidence,",
    "};",
  ].join('\n'), 'utf8'),
  'missing-export': (gatesDir) => writeFileSync(join(gatesDir, 'evidence.cjs'), [
    "'use strict';",
    "// 測試用壞版本：故意不匯出 checkLatestEvidence（呼叫端拿到 undefined，呼叫它會丟 TypeError）。",
    "module.exports = {",
    "  SECRET_PATH: '(broken)', readSecret: () => null, ticketRelPath: (p) => p,",
    "  repoRootToken: (p) => p, computeSignature: () => '', COMMAND_LINE_RE: /x/,",
    "};",
  ].join('\n'), 'utf8'),
  // 對抗審查 should-fix：不丟例外、也不是已知失敗代碼，單純「忘了 return」——呼叫端必須把
  // undefined 當成擋下（=== 'ok' 才放行），不能因為沒有 throw 就走漏到 fail-open。
  'returns-undefined': (gatesDir) => writeFileSync(join(gatesDir, 'evidence.cjs'), [
    "'use strict';",
    "// 測試用壞版本：checkLatestEvidence 沒有任何 return（回傳 undefined），不丟例外。",
    "function checkLatestEvidence() {}",
    "module.exports = {",
    "  SECRET_PATH: '(broken)', readSecret: () => null, ticketRelPath: (p) => p,",
    "  repoRootToken: (p) => p, computeSignature: () => '', COMMAND_LINE_RE: /x/, checkLatestEvidence,",
    "};",
  ].join('\n'), 'utf8'),
};

function makeSecretHome() {
  const home = mkdtempSync(join(tmpdir(), 'evfail-home-'));
  mkdirSync(join(home, '.constellation'), { recursive: true });
  writeFileSync(join(home, '.constellation', 'secret'), 'test-secret-evfail', 'utf8');
  return home;
}

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'evfail-repo-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  mkdirSync(join(dir, '.constellation', 'tickets'), { recursive: true });
  return dir;
}

// 用真正沒壞掉的 verify-runner.mjs 簽一筆合法證據，回傳票檔絕對路徑（status 已是 done）。
function makeLegalDoneTicket(repoDir, homeDir) {
  const okScript = join(repoDir, 'ok.mjs');
  writeFileSync(okScript, "console.log('ok');\n", 'utf8');
  writeFileSync(join(repoDir, '.constellation', 'config.json'), JSON.stringify({ commands: {} }), 'utf8');
  const ticket = join(repoDir, '.constellation', 'tickets', 'T-921-legal.md');
  writeFileSync(ticket, [
    '---', 'status: done', '---', '# T-921 demo', '',
    '## 驗收條件', '- [x] 條件一', '',
    '## 決議記錄', '',
    '## 驗證指令',
    `- \`node "${okScript.replace(/\\/g, '/')}"\``,
    '',
    '## 驗證證據（關票時由 runner 寫入）', '',
  ].join('\n'), 'utf8');
  const r = spawnSync(process.execPath, [REAL_RUNNER, '--ticket', ticket, '--scope', 'ticket', '--cwd', repoDir], {
    env: { ...process.env, USERPROFILE: homeDir, HOME: homeDir },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`fixture 簽章失敗（exit ${r.status}）：${r.stderr}`);
  return ticket;
}

function runCloseGate(gatesDir, input, homeDir) {
  const r = spawnSync(process.execPath, [join(gatesDir, 'close-gate.mjs')], {
    input: JSON.stringify(input),
    env: { ...process.env, USERPROFILE: homeDir, HOME: homeDir },
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr || '' };
}

function runDispatch(gatesDir, input, homeDir) {
  const r = spawnSync(process.execPath, [join(gatesDir, 'pre-tool-use.mjs')], {
    input: JSON.stringify(input),
    env: { ...process.env, USERPROFILE: homeDir, HOME: homeDir },
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr || '' };
}

describe('evidence.cjs 失效語義（P14 第三步：三種壞法 × 六個斷言）', () => {
  let secretHome;
  const cleanupDirs = [];

  before(() => {
    secretHome = mkdtempSync(join(tmpdir(), 'evfail-home-'));
    mkdirSync(join(secretHome, '.constellation'), { recursive: true });
    writeFileSync(join(secretHome, '.constellation', 'secret'), 'test-secret-evfail', 'utf8');
    cleanupDirs.push(secretHome);
  });

  after(() => {
    for (const d of cleanupDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  function track(dir) { cleanupDirs.push(dir); return dir; }

  for (const [variantName, breakIt] of Object.entries(BROKEN)) {
    describe(`壞法：${variantName}`, () => {
      let gatesDir;

      before(() => {
        gatesDir = track(copyGates());
        breakIt(gatesDir);
      });

      test('凍結檔編輯仍擋下（exit 2）——凍結守衛跟 evidence.cjs 無關', () => {
        const repoDir = track(gitRepo());
        const page = join(repoDir, 'web-src-Page.tsx'); // 檔名不含子目錄，減少夾具設置
        writeFileSync(page, '<div>1</div>', 'utf8');
        writeFileSync(join(repoDir, '.constellation', 'design-frozen.json'),
          JSON.stringify({ frozen: ['web-src-Page.tsx'], source: 'test', log: [] }), 'utf8');
        const r = runCloseGate(gatesDir, {
          tool_name: 'Edit', cwd: repoDir, tool_input: { file_path: page, old_string: '1', new_string: '2' },
        }, secretHome);
        assert.equal(r.status, 2, `應擋下，實際 exit ${r.status}｜${r.stderr.slice(0, 300)}`);
        assert.match(r.stderr, /凍結守衛/);
      });

      test('staged .env 的 commit 仍擋下（exit 2）——secrets 閘門跟 evidence.cjs 無關', () => {
        const repoDir = track(gitRepo());
        writeFileSync(join(repoDir, '.env'), 'SECRET=1\n', 'utf8');
        spawnSync('git', ['add', '-f', '.env'], { cwd: repoDir });
        const r = runDispatch(gatesDir, {
          tool_name: 'Bash', cwd: repoDir, tool_input: { command: 'git commit -m "x"' },
        }, secretHome);
        assert.equal(r.status, 2, `應擋下，實際 exit ${r.status}｜${r.stderr.slice(0, 300)}`);
      });

      test('合法 done 票關票仍回 2，訊息含「簽章模組」——模組故障不是繞過刷卡機', () => {
        const repoDir = track(gitRepo());
        const ticket = makeLegalDoneTicket(repoDir, secretHome);
        const r = runCloseGate(gatesDir, {
          tool_name: 'Edit', cwd: repoDir,
          tool_input: { file_path: ticket, old_string: 'x', new_string: 'status: done' },
        }, secretHome);
        assert.equal(r.status, 2, `應擋下，實際 exit ${r.status}｜${r.stderr.slice(0, 300)}`);
        assert.match(r.stderr, /簽章模組/, `訊息應含「簽章模組」，實際：${r.stderr}`);
      });

      test('含合法 done 票的 commit 被擋，訊息含「簽章模組」——模組故障不是繞過刷卡機', () => {
        const repoDir = track(gitRepo());
        const ticket = makeLegalDoneTicket(repoDir, secretHome);
        spawnSync('git', ['add', ticket], { cwd: repoDir });
        const r = runDispatch(gatesDir, {
          tool_name: 'Bash', cwd: repoDir, tool_input: { command: 'git commit -m "x"' },
        }, secretHome);
        assert.equal(r.status, 2, `應擋下，實際 exit ${r.status}｜${r.stderr.slice(0, 300)}`);
        assert.match(r.stderr, /簽章模組/, `訊息應含「簽章模組」，實際：${r.stderr}`);
      });

      test('git push --force 仍擋下（exit 2）——git 守門跟 evidence.cjs 無關', () => {
        const repoDir = track(gitRepo());
        const r = runDispatch(gatesDir, {
          tool_name: 'Bash', cwd: repoDir, tool_input: { command: 'git push --force origin main' },
        }, secretHome);
        assert.equal(r.status, 2, `應擋下，實際 exit ${r.status}｜${r.stderr.slice(0, 300)}`);
      });

      test('一般編輯仍放行（exit 0）——非票檔完全不碰 evidence.cjs', () => {
        const repoDir = track(gitRepo());
        const normalFile = join(repoDir, 'README.md');
        writeFileSync(normalFile, 'hello', 'utf8');
        const r = runCloseGate(gatesDir, {
          tool_name: 'Edit', cwd: repoDir, tool_input: { file_path: normalFile, old_string: 'hello', new_string: 'world' },
        }, secretHome);
        assert.equal(r.status, 0, `應放行，實際 exit ${r.status}｜${r.stderr.slice(0, 300)}`);
      });
    });
  }
});
