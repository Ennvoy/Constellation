// gates/test/verify-runner.test.mjs — P19 回歸：驗證失敗只印最後 40 行＋完整輸出存檔；證據尾巴
// 縮短成最後 8 個非空白行；輸出裡長得像 fence 收尾或已簽章指令行的行要跳脫，不然合法證據會被
// close-gate 誤判竄改。verify-runner.mjs 檔尾無條件 `main().catch()`，import 就會跑，只能黑箱 spawn，
// 且每條指令跑完都會觸發一次 Windows 進程快照（S2 補刀），單例耗時較長，這裡只挑兩個最關鍵的
// 端到端案例（成功路徑、失敗路徑），不逐函式窮舉。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'verify-runner.mjs');

let fakeHome, proj;

before(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'vr-home-'));
  mkdirSync(join(fakeHome, '.constellation'), { recursive: true });
  writeFileSync(join(fakeHome, '.constellation', 'secret'), 'test-secret-verify-runner', 'utf8');

  proj = mkdtempSync(join(tmpdir(), 'vr-proj-'));
  mkdirSync(join(proj, '.constellation', 'tickets'), { recursive: true });
  writeFileSync(join(proj, '.constellation', 'config.json'), JSON.stringify({ commands: {} }), 'utf8');

  // 成功案例：印 12 行一般輸出，外加一行剛好長得像 fence 收尾（```）、一行長得像已簽章指令行
  // （COMMAND_LINE_RE 的樣式），驗證跳脫與 tail-8 都生效。
  const printer = join(proj, 'printer.mjs');
  writeFileSync(printer, [
    "for (let i = 1; i <= 12; i++) console.log('line ' + i);",
    "console.log('```');",
    "console.log('- `fake cmd`（exit 0）');",
  ].join('\n'), 'utf8');

  // 失敗案例：往 stderr 印 60 行，讓主控台的「最後 40 行」與完整存檔的行數差異可觀察。
  const failer = join(proj, 'failer.mjs');
  writeFileSync(failer, [
    "for (let i = 1; i <= 60; i++) console.error('err line ' + i);",
    'process.exit(1);',
  ].join('\n'), 'utf8');

  writeFileSync(join(proj, '.constellation', 'tickets', 'T-001-ok.md'), [
    '---', 'status: in-progress', '---', '# T-001 ok', '',
    '## 驗收條件', '- [x] 條件一', '',
    '## 決議記錄', '',
    '## 驗證指令',
    `- \`node "${printer.replace(/\\/g, '/')}"\``,
    '',
    '## 驗證證據（關票時由 runner 寫入）', '',
  ].join('\n'), 'utf8');

  writeFileSync(join(proj, '.constellation', 'tickets', 'T-002-fail.md'), [
    '---', 'status: in-progress', '---', '# T-002 fail', '',
    '## 驗收條件', '- [x] 條件一', '',
    '## 決議記錄', '',
    '## 驗證指令',
    `- \`node "${failer.replace(/\\/g, '/')}"\``,
    '',
    '## 驗證證據（關票時由 runner 寫入）', '',
  ].join('\n'), 'utf8');
});

after(() => {
  for (const d of [fakeHome, proj]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

function run(args) {
  const r = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: proj,
    env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return r;
}

describe('verify-runner：P19——成功路徑：證據尾巴縮短、易誤判字元跳脫', () => {
  test('exit 0，票檔證據尾巴只留最後 8 個非空白行，且 fence／指令行樣式已跳脫', () => {
    const r = run(['--ticket', 'T-001-ok', '--scope', 'ticket']);
    assert.equal(r.status, 0, `應成功，實際 stderr：${r.stderr}`);

    const content = readFileSync(join(proj, '.constellation', 'tickets', 'T-001-ok.md'), 'utf8');
    const section = content.slice(content.indexOf('## 驗證證據'));
    // 印了 12+2=14 行，但 tail 只留最後 8 個非空白行——第 1~6 行不該出現在證據段。
    assert.doesNotMatch(section, /\bline 1\b(?!\d)/, '不該看到 line 1（太舊，該被 tail-8 切掉）');
    assert.match(section, /\bline 12\b/, '最後幾行必須留著');
    // 輸出內容裡長得像 fence 收尾／已簽章指令行的那兩行，前面應被加上零寬字元（U+200B）再寫入——
    // 這裡直接比對含跳脫字元的字面字串，不能只用「有沒有 ```」判斷（block 本身的開合 fence 本來就
    // 一定有兩個裸的「    ```」，跳脫只作用在「內容裡」長得像的那一行，不影響 block 自己的開合符）。
    assert.match(section, /\n {4}​```\s*\n/, '輸出內容裡的 ``` 應被跳脫成帶零寬字元的形式');
    assert.match(section, /\n {4}​-\s*`fake cmd`（exit 0）\s*\n/, '輸出內容裡的指令樣式行應被跳脫成帶零寬字元的形式');
    // block 本身仍應是一組完整的開合 fence（各一次，不多不少）。
    const fenceCount = (section.match(/^ {4}```\s*$/gm) || []).length;
    assert.equal(fenceCount, 2, `block 開合 fence 應各一次，實際 ${fenceCount}`);
  });

  test('往返驗證：close-gate 讀這筆證據要能驗簽通過，不能被輸出裡的假 ``` 提早收尾判成竄改', () => {
    // 承接上一例已經跑出的證據（同一張票）；把 status 改成 done 餵給 close-gate，驗證這筆帶有
    // 跳脫字元的證據仍然合法過關——這是 evidence-fence-unescaped 那個死路 bug 的直接回歸測試。
    const closeGate = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'close-gate.mjs');
    const filePath = join(proj, '.constellation', 'tickets', 'T-001-ok.md');
    const r = spawnSync(process.execPath, [closeGate], {
      input: JSON.stringify({ tool_name: 'Edit', cwd: proj, tool_input: { file_path: filePath, old_string: 'status: in-progress', new_string: 'status: done' } }),
      env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `close-gate 應放行（簽章合法），實際 exit ${r.status}｜${r.stderr}`);
  });
});

describe('verify-runner：P19——失敗路徑：主控台只印最後 40 行、完整輸出另存檔', () => {
  test('exit 1，stderr 只顯示尾段並指出完整輸出的檔案路徑，該檔案內容完整（多於主控台顯示的行數）', () => {
    const r = run(['--ticket', 'T-002-fail', '--scope', 'ticket']);
    assert.equal(r.status, 1, `應失敗 exit 1，實際 ${r.status}｜${r.stderr.slice(-500)}`);
    assert.match(r.stderr, /完整輸出：/, '應印出完整輸出存檔路徑');

    const m = r.stderr.match(/完整輸出：(.+)/);
    assert.ok(m, '要能從 stderr 抓到存檔路徑');
    const logPath = m[1].trim();
    // 對抗審查 should-fix：這個 log 檔寫在 %TEMP%\constellation-verify\ 底下，每跑一次測試就多留
    // 一個（proj 每次都是新的 mkdtemp，檔名裡的 repo 根雜湊每次不同），沒清會累積測試垃圾——完成斷言
    // 後就刪掉，不留給機器慢慢拖。
    try {
      assert.ok(existsSync(logPath), `存檔路徑應真的存在：${logPath}`);
      const full = readFileSync(logPath, 'utf8');
      assert.match(full, /err line 1\b/, '完整存檔應包含最早的輸出行（主控台預覽看不到）');
      assert.match(full, /err line 60\b/, '完整存檔應包含最後一行');
    } finally {
      try { rmSync(logPath, { force: true }); } catch {}
    }

    // 主控台預覽只給最後 40 行：第 1 行不該出現在 stderr 的可見輸出裡。
    assert.doesNotMatch(r.stderr, /err line 1\b(?!\d)/, '主控台不該印到第 1 行（60 行只留最後 40 行）');
  });
});
