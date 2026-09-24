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

// 對抗複審 S2：完整輸出存檔在 %TEMP%\constellation-verify\ 底下，是全機所有專案共用的資料夾，
// 不是本檔測試專屬——收尾不能把整個資料夾清掉（會誤刪其他 session 剛失敗、正要讀的完整輸出）。
// 從 stderr 的「完整輸出：」抓出這次測試自己那一份路徑，只刪那一個檔。
function cleanupFailureLog(stderr) {
  const m = String(stderr).match(/完整輸出：(.+)/);
  if (!m) return;
  try { rmSync(m[1].trim(), { force: true }); } catch {}
}

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

// P9／P15 各自用獨立的暫存專案（不沿用上面 proj 共用的 config.json），避免互相干擾各自要蓋的
// timeoutSec／commands 設定；仍共用同一份 fakeHome（簽章 secret 與各案例無關）。

describe('verify-runner：P9——逾時語意改成「連續多久沒有輸出」，不是從開跑算起的總時長', () => {
  let p9proj;

  before(() => {
    p9proj = mkdtempSync(join(tmpdir(), 'vr-proj-p9-'));
    mkdirSync(join(p9proj, '.constellation', 'tickets'), { recursive: true });

    // 每段間隔 2 秒印一行、共 4 段（跨約 6 秒）：間隔小於下面設的 timeoutSec=4，
    // 若逾時是「總時長」語意（舊版）會在 4 秒整被腰斬；若是「連續無輸出」語意（新版）不該被砍。
    // 間隔與總長各留 2 秒緩衝——第一輪原本用 1.2 秒／timeoutSec=2（緩衝僅 0.8 秒），實測在本機
    // 背景負載高時（其他 node/MCP 行程搶 CPU、child_process 經 cmd.exe 兩層 spawn 的排程抖動）
    // 有相當機率把單純的排程延遲誤判成真逾時，測試假紅但程式邏輯本身無誤；加大緩衝後才穩定。
    const chatty = join(p9proj, 'chatty.mjs');
    writeFileSync(chatty, [
      "console.log('c1');",
      "setTimeout(() => {",
      "  console.log('c2');",
      "  setTimeout(() => {",
      "    console.log('c3');",
      "    setTimeout(() => { console.log('c4'); }, 2000);",
      "  }, 2000);",
      "}, 2000);",
    ].join('\n'), 'utf8');
    writeFileSync(join(p9proj, '.constellation', 'tickets', 'T-901-chatty.md'), [
      '---', 'status: in-progress', '---', '# T-901 chatty', '',
      '## 驗收條件', '- [x] 條件一', '',
      '## 決議記錄', '',
      '## 驗證指令',
      `- \`node "${chatty.replace(/\\/g, '/')}"\``,
      '',
      '## 驗證證據（關票時由 runner 寫入）', '',
    ].join('\n'), 'utf8');

    // 完全不印任何東西，3 秒後才自己退出——用來驗證「真的連續無輸出」仍會被判定逾時。
    const silent = join(p9proj, 'silent.mjs');
    writeFileSync(silent, 'setTimeout(() => process.exit(0), 3000);', 'utf8');
    writeFileSync(join(p9proj, '.constellation', 'tickets', 'T-902-silent.md'), [
      '---', 'status: in-progress', '---', '# T-902 silent', '',
      '## 驗收條件', '- [x] 條件一', '',
      '## 決議記錄', '',
      '## 驗證指令',
      `- \`node "${silent.replace(/\\/g, '/')}"\``,
      '',
      '## 驗證證據（關票時由 runner 寫入）', '',
    ].join('\n'), 'utf8');

    // 用 setInterval 一直印、永遠不主動退出——用來驗證「一直印卻永遠不結束」仍會被 6 小時
    // 總上限（測試逃生窗覆寫成極短值）砍掉，不會因為一直有輸出就被無輸出逾時放過。
    const forever = join(p9proj, 'chatty-forever.mjs');
    writeFileSync(forever, "setInterval(() => console.log('tick'), 150);", 'utf8');
    writeFileSync(join(p9proj, '.constellation', 'tickets', 'T-903-forever.md'), [
      '---', 'status: in-progress', '---', '# T-903 forever', '',
      '## 驗收條件', '- [x] 條件一', '',
      '## 決議記錄', '',
      '## 驗證指令',
      `- \`node "${forever.replace(/\\/g, '/')}"\``,
      '',
      '## 驗證證據（關票時由 runner 寫入）', '',
    ].join('\n'), 'utf8');
  });

  after(() => {
    try { rmSync(p9proj, { recursive: true, force: true }); } catch {}
  });

  function runP9(ticket, timeoutSec, extraEnv = {}) {
    writeFileSync(join(p9proj, '.constellation', 'config.json'), JSON.stringify({ commands: {}, timeoutSec }), 'utf8');
    return spawnSync(process.execPath, [RUNNER, '--ticket', ticket, '--scope', 'ticket'], {
      cwd: p9proj,
      env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, ...extraEnv },
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  test('間隔 2 秒有輸出、timeoutSec=4 秒——不該被砍（舊版「總時長」語意在總長 6 秒時會誤殺）', () => {
    const r = runP9('T-901-chatty', 4);
    assert.equal(r.status, 0, `間隔內持續有輸出，不該判定逾時，實際 stderr：${r.stderr}`);
  });

  test('真的連續 0.6 秒沒有任何輸出——仍判定逾時，訊息改成「沒有任何輸出」（不是「未結束」）', () => {
    const r = runP9('T-902-silent', 0.6);
    assert.equal(r.status, 1, `應逾時失敗，實際 ${r.status}｜${r.stderr.slice(-300)}`);
    assert.match(r.stderr, /逾時：超過 0\.6 秒沒有任何輸出，已強制終止該指令。/, '訊息應是「沒有任何輸出」語意');
    cleanupFailureLog(r.stderr);
  });

  test('6 小時總上限（測試逃生窗覆寫成極短值）：一直有輸出也會被砍，訊息點名「總執行時間上限」', () => {
    // 無輸出逾時故意設很寬（30 秒），確保先撞到的是 6 小時總上限的覆寫值，不是無輸出逾時。
    const r = runP9('T-903-forever', 30, { CONSTELLATION_VERIFY_TEST_ABS_MAX_MS: '800' });
    assert.equal(r.status, 1, `應被總上限覆寫值砍掉，實際 ${r.status}｜${r.stderr.slice(-300)}`);
    assert.match(r.stderr, /已達 6 小時總執行時間上限（\d+ 秒）/, '應點名撞到的是總執行時間上限，不是無輸出逾時');
    cleanupFailureLog(r.stderr);
  });
});

describe('verify-runner：P15——遇到第一條紅燈即停，多印未執行清單；ship 語意與斷路器新一輪判定', () => {
  let p15proj;

  before(() => {
    p15proj = mkdtempSync(join(tmpdir(), 'vr-proj-p15-'));
    mkdirSync(join(p15proj, '.constellation', 'tickets'), { recursive: true });
    writeFileSync(join(p15proj, '.constellation', 'config.json'), JSON.stringify({ commands: {} }), 'utf8');
  });

  after(() => {
    try { rmSync(p15proj, { recursive: true, force: true }); } catch {}
  });

  test('票內兩條指令，第一條紅——第二條不執行，且多印「以下指令因前一條紅燈未執行：…」點名它', () => {
    const failer = join(p15proj, 'failer.mjs');
    writeFileSync(failer, 'process.exit(1);', 'utf8');
    const markerFlag = join(p15proj, 'marker-ran.txt');
    const marker = join(p15proj, 'marker.mjs');
    writeFileSync(marker, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(markerFlag)}, 'ran');`, 'utf8');

    const failerCmd = `node "${failer.replace(/\\/g, '/')}"`;
    const markerCmd = `node "${marker.replace(/\\/g, '/')}"`;
    writeFileSync(join(p15proj, '.constellation', 'tickets', 'T-904-two.md'), [
      '---', 'status: in-progress', '---', '# T-904 two', '',
      '## 驗收條件', '- [x] 條件一', '',
      '## 決議記錄', '',
      '## 驗證指令',
      `- \`${failerCmd}\``,
      `- \`${markerCmd}\``,
      '',
      '## 驗證證據（關票時由 runner 寫入）', '',
    ].join('\n'), 'utf8');

    const r = spawnSync(process.execPath, [RUNNER, '--ticket', 'T-904-two', '--scope', 'ticket'], {
      cwd: p15proj,
      env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(r.status, 1, `第一條紅應停下，實際 ${r.status}｜${r.stderr.slice(-300)}`);
    assert.match(r.stderr, /以下指令因前一條紅燈未執行：/, '應印出未執行清單這一行');
    assert.ok(r.stderr.includes(markerCmd), `未執行清單應點名第二條指令：${r.stderr.slice(-300)}`);
    assert.ok(!existsSync(markerFlag), '第二條指令不該被執行到（旗標檔不該存在）');
    cleanupFailureLog(r.stderr);
  });

  test('--scope ship 失敗訊息用 ship 語意（這一輪不能出貨），不是票級用語「這張票不能標 done」', () => {
    const shipProj = mkdtempSync(join(tmpdir(), 'vr-proj-p15-ship-'));
    mkdirSync(join(shipProj, '.constellation'), { recursive: true });
    const failer = join(shipProj, 'failer.mjs');
    writeFileSync(failer, 'process.exit(1);', 'utf8');
    writeFileSync(join(shipProj, '.constellation', 'config.json'), JSON.stringify({
      commands: { test: [`node "${failer.replace(/\\/g, '/')}"`], journey: [] },
    }), 'utf8');

    try {
      const r = spawnSync(process.execPath, [RUNNER, '--cwd', shipProj, '--scope', 'ship'], {
        env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome },
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(r.status, 1, `應失敗，實際 ${r.status}｜${r.stderr.slice(-300)}`);
      assert.match(r.stderr, /這一輪不能出貨/, '應是 ship 語意');
      assert.doesNotMatch(r.stderr, /這張票不能標 done/, '不該再沿用票級用語');
      cleanupFailureLog(r.stderr);
    } finally {
      try { rmSync(shipProj, { recursive: true, force: true }); } catch {}
    }
  });

  test('ship 斷路器新一輪判定：ship-evidence.md 不存在就先歸零，不會沿用上一輪的失敗次數', () => {
    const shipProj = mkdtempSync(join(tmpdir(), 'vr-proj-p15-breaker-'));
    mkdirSync(join(shipProj, '.constellation'), { recursive: true });
    const failer = join(shipProj, 'failer.mjs');
    writeFileSync(failer, 'process.exit(1);', 'utf8');
    writeFileSync(join(shipProj, '.constellation', 'config.json'), JSON.stringify({
      commands: { test: [`node "${failer.replace(/\\/g, '/')}"`], journey: [] },
    }), 'utf8');

    const runShip = () => spawnSync(process.execPath, [RUNNER, '--cwd', shipProj, '--scope', 'ship'], {
      env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome },
      encoding: 'utf8',
      timeout: 30_000,
    });

    try {
      const r1 = runShip();
      assert.equal(r1.status, 1, `第一輪應失敗，實際 ${r1.status}｜${r1.stderr.slice(-300)}`);
      const statePath = join(shipProj, '.constellation', '.verify-state.json');
      const state1 = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.equal(state1.targets.ship, 1, '第一輪失敗後計數應為 1');

      // 模擬歸檔：ship-evidence.md 被移除（真實流程是整批移進 archive/），代表新一輪開始。
      rmSync(join(shipProj, '.constellation', 'ship-evidence.md'), { force: true });

      const r2 = runShip();
      assert.equal(r2.status, 1, `第二輪應失敗，實際 ${r2.status}｜${r2.stderr.slice(-300)}`);
      const state2 = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.equal(state2.targets.ship, 1, 'ship-evidence.md 不存在應先歸零，第二輪失敗後應是 1（不是累加成 2）');
      cleanupFailureLog(r2.stderr);
    } finally {
      try { rmSync(shipProj, { recursive: true, force: true }); } catch {}
    }
  });

  // 對抗複審 S1：現有測試只驗過「ship-evidence.md 被移除→歸零」，沒驗「檔案還在時要累加」——
  // 把斷路器改壞成每次無條件歸零，這支測試出現前全套測試仍會全線綘燈。這裡同一輪（不刪
  // ship-evidence.md）連續跑五次失敗，斷言計數確實累加、且第 5 次真的觸發斷路器 exit 2。
  test('ship 斷路器同一輪累加：ship-evidence.md 沒被移除時連續失敗要累加，第 5 次觸發斷路器 exit 2', () => {
    const shipProj = mkdtempSync(join(tmpdir(), 'vr-proj-p15-breaker-accum-'));
    mkdirSync(join(shipProj, '.constellation'), { recursive: true });
    const failer = join(shipProj, 'failer.mjs');
    writeFileSync(failer, 'process.exit(1);', 'utf8');
    writeFileSync(join(shipProj, '.constellation', 'config.json'), JSON.stringify({
      commands: { test: [`node "${failer.replace(/\\/g, '/')}"`], journey: [] },
    }), 'utf8');

    const runShip = () => spawnSync(process.execPath, [RUNNER, '--cwd', shipProj, '--scope', 'ship'], {
      env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome },
      encoding: 'utf8',
      timeout: 30_000,
    });
    const statePath = join(shipProj, '.constellation', '.verify-state.json');

    try {
      let last;
      for (let i = 1; i <= 4; i++) {
        last = runShip();
        assert.equal(last.status, 1, `第 ${i} 次應是一般失敗（還沒到第 5 次），實際 ${last.status}｜${last.stderr.slice(-300)}`);
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        assert.equal(state.targets.ship, i, `同一輪內第 ${i} 次失敗後計數應累加為 ${i}，不能被誤判成歸零`);
      }
      const r5 = runShip();
      assert.equal(r5.status, 2, `第 5 次應觸發斷路器 exit 2，實際 ${r5.status}｜${r5.stderr.slice(-300)}`);
      assert.match(r5.stderr, /連續驗證失敗已達 5 次/, '應印出斷路器訊息');
      cleanupFailureLog(last.stderr);
      cleanupFailureLog(r5.stderr);
    } finally {
      try { rmSync(shipProj, { recursive: true, force: true }); } catch {}
    }
  });
});

// 對抗複審 S5：無輸出計時器與 6 小時總上限計時器沒有互斥——taskkill 殺不動時，先撞到總上限判定
// 逾時原因後，姍姍來遲的舊無輸出計時器還會觸發，把 hitAbsoluteMax 改回 false、訊息因此報錯原因
// （見 verify-runner.mjs onTimeout 的修法：判定過就直接返回，並清掉另一顆還沒觸發的計時器）。
// 只跑一個案例：PATH 限縮到只留 node 自己的目錄，讓 spawnSync('taskkill',...) 找不到執行檔而
// ENOENT（不會真的殺掉樹，行程繼續存活、繼續印），據此重現「舊計時器姍姍來遲」的必要條件；
// cmd.exe 走 ComSpec 絕對路徑不受影響，子行程解析裸指令「node」才需要這個目錄在 PATH 裡。
// HARD_STOP_AFTER_KILL_MS 固定 10 秒、不可測試覆寫，這支案例因此無可避免要等 10+ 秒。
describe('verify-runner：S5——無輸出計時器與總上限計時器互斥，不重複殺樹／不被姍姍來遲的舊計時器改判逾時原因', () => {
  let s5proj;

  before(() => {
    s5proj = mkdtempSync(join(tmpdir(), 'vr-proj-s5-'));
    mkdirSync(join(s5proj, '.constellation', 'tickets'), { recursive: true });
    // 持續印、永遠不自己退出：taskkill 失效時進程會繼續存活，讓「總上限判定逾時之前就已武裝、
    // 卻沒被清掉」的舊無輸出計時器有機會在總上限判定之後才觸發。
    const forever = join(s5proj, 'forever.mjs');
    writeFileSync(forever, "setInterval(() => console.log('tick'), 100);", 'utf8');
    writeFileSync(join(s5proj, '.constellation', 'tickets', 'T-905-s5.md'), [
      '---', 'status: in-progress', '---', '# T-905 s5', '',
      '## 驗收條件', '- [x] 條件一', '',
      '## 決議記錄', '',
      '## 驗證指令',
      `- \`node "${forever.replace(/\\/g, '/')}"\``,
      '',
      '## 驗證證據（關票時由 runner 寫入）', '',
    ].join('\n'), 'utf8');
    writeFileSync(join(s5proj, '.constellation', 'config.json'), JSON.stringify({ commands: {}, timeoutSec: 3 }), 'utf8');
  });

  after(() => {
    try { rmSync(s5proj, { recursive: true, force: true }); } catch {}
  });

  test('taskkill 失效、總上限先撞到時：訊息要點名總上限，不能被姍姍來遲的舊無輸出計時器改判成「沒有任何輸出」', () => {
    const nodeDir = dirname(process.execPath);
    const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, CONSTELLATION_VERIFY_TEST_ABS_MAX_MS: '1000' };
    env.PATH = nodeDir; // 限縮到只留 node 自己的目錄——taskkill.exe 因此找不到（ENOENT），殺不掉樹
    const r = spawnSync(process.execPath, [RUNNER, '--ticket', 'T-905-s5', '--scope', 'ticket'], {
      cwd: s5proj,
      env,
      encoding: 'utf8',
      timeout: 25_000,
    });
    assert.equal(r.status, 1, `應逾時失敗，實際 ${r.status}｜${r.stderr.slice(-400)}`);
    assert.match(r.stderr, /已達 6 小時總執行時間上限/, '應點名撞到的是總上限——這是真正的觸發原因');
    assert.doesNotMatch(r.stderr, /超過 3 秒沒有任何輸出/, '不該出現無輸出逾時訊息（那是姍姍來遲的舊計時器誤判）');
    cleanupFailureLog(r.stderr);
  });
});
