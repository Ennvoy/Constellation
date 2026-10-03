// gates/test/verify-runner.test.mjs — P19 回歸：驗證失敗只印最後 40 行＋完整輸出存檔；證據尾巴
// 縮短成最後 8 個非空白行；輸出裡長得像 fence 收尾或已簽章指令行的行要跳脫，不然合法證據會被
// close-gate 誤判竄改。verify-runner.mjs 檔尾無條件 `main().catch()`，import 就會跑，只能黑箱 spawn，
// 且每條指令跑完都會觸發一次 Windows 進程快照（S2 補刀），單例耗時較長，這裡只挑兩個最關鍵的
// 端到端案例（成功路徑、失敗路徑），不逐函式窮舉。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectKey } from '../lease.mjs';

const RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'verify-runner.mjs');
const LEASE_MJS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lease.mjs');

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

// 決議 026、033：--scope ship 開跑前搶跨 session 的出貨鎖（gates/lease.mjs），同專案被佔就排隊，
// 別的專案持有不排隊（只提醒）。專案鍵是主工作樹根的雜湊，登記在 leases/<鍵>/holder.json。
// 「持有方」一律用這裡自己 spawn 的真行程模擬（讀 lease.mjs 的 acquire 直接登記自己），
// 不是憑空捏造 PID——這樣「pid 已死」「pid 還活著」兩種情境都是真實可觀察的行程狀態。
// 全部案例共用同一個 fakeHome（leaseHome），登記檔只寫在它底下，絕不碰真正的 ~/.constellation/leases；
// 每個成功接手/搶到鎖的案例收尾都清掉自己留下的 ship-evidence／.verify-state，避免互相汙染。
describe('verify-runner ×lease：--scope ship 開跑前搶本專案的出貨鎖，同專案被佔就排隊（決議 026、033）', () => {
  let leaseHome, leaseProj, fakeHolderScript;

  before(() => {
    leaseHome = mkdtempSync(join(tmpdir(), 'vr-lease-home-'));
    mkdirSync(join(leaseHome, '.constellation'), { recursive: true });
    writeFileSync(join(leaseHome, '.constellation', 'secret'), 'test-secret-lease', 'utf8');

    leaseProj = mkdtempSync(join(tmpdir(), 'vr-lease-proj-'));
    mkdirSync(join(leaseProj, '.constellation', 'tickets'), { recursive: true });
    writeFileSync(join(leaseProj, '.constellation', 'config.json'), JSON.stringify({
      commands: { test: ['node -e "process.exit(0)"'], journey: [] },
    }), 'utf8');

    // 假持有者：直接呼叫 lease.mjs 的 acquire 登記自己，撐 argv[2] 毫秒後自然結束（不主動釋放，
    // 模擬「行程死了但登記檔還留著」，靠等待方自己的失效判定去回收）。argv[3] 是它代表的專案目錄
    // （登記在該專案的鍵底下）；argv[4] 給了就當登記目錄名（用來模擬舊版 leases/machine 登記，沒有 key 欄位）。
    fakeHolderScript = join(leaseProj, 'fake-holder.mjs');
    writeFileSync(fakeHolderScript, [
      // import 規格必須是合法的 file:// URL——Windows 上帶碟符的裸絕對路徑不是合法的 ESM 規格
      // （會丟 ERR_UNSUPPORTED_ESM_URL_SCHEME），故一律用 pathToFileURL 轉換。
      `import { acquire, projectKey } from ${JSON.stringify(pathToFileURL(LEASE_MJS).href)};`,
      "const holdMs = Number(process.argv[2] || '3000');",
      "const proj = process.argv[3] || 'fake-project';",
      "const legacyDir = process.argv[4];",
      'const startedAt = Date.now() - Math.round(process.uptime() * 1000);',
      "const entry = { root: proj, session: 'fake-session', runtime: 'test', pid: process.pid, startedAt, purpose: '假持有者（測試用）', estimatedEndAt: null, shellPid: null };",
      'if (!legacyDir) entry.key = projectKey(proj);',
      'const r = acquire(legacyDir || projectKey(proj), entry);',
      "if (!r.ok) { console.error('acquire-failed'); process.exit(1); }",
      "console.log('ACQUIRED');",
      'setTimeout(() => process.exit(0), holdMs);',
    ].join('\n'), 'utf8');
  });

  after(() => {
    for (const d of [leaseHome, leaseProj]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  // 某個專案的登記檔路徑（預設是 leaseProj 這個專案）；legacyDir 給了就是舊版目錄（例如 'machine'）。
  const holderFilePath = (proj = leaseProj, legacyDir) =>
    join(leaseHome, '.constellation', 'leases', legacyDir || projectKey(proj), 'holder.json');
  // 造一個專案目錄：主工作樹（.git 是目錄）。
  const makeMainProject = (prefix, commands = { test: ['node -e "process.exit(0)"'], journey: [] }) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    mkdirSync(join(dir, '.constellation', 'tickets'), { recursive: true });
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.constellation', 'config.json'), JSON.stringify({ commands }), 'utf8');
    return dir;
  };
  // 造同一個 repo 的另一個 worktree：手工搭 `git worktree add` 留下的形狀（不叫 git）——.git 是檔案、
  // 指向主 repo 的 .git/worktrees/<名>，裡頭 commondir 指回共用的 .git；worktree 自己有一份 .constellation。
  const makeWorktreeOf = (mainDir, prefix, commands = { test: ['node -e "process.exit(0)"'], journey: [] }) => {
    const wt = mkdtempSync(join(tmpdir(), prefix));
    const gitdir = join(mainDir, '.git', 'worktrees', 'wt-test');
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, 'commondir'), '../..\n', 'utf8');
    writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`, 'utf8');
    mkdirSync(join(wt, '.constellation', 'tickets'), { recursive: true });
    writeFileSync(join(wt, '.constellation', 'config.json'), JSON.stringify({ commands }), 'utf8');
    return wt;
  };

  // 對抗複審 S6：本檔測試自己的 process.env 可能剛好也是被一支真的 `--scope ship` 的
  // commands.test 呼叫出來的（那支 runner 早就在自己身上設了 CONSTELLATION_LEASE_ACQUIRED），
  // 直接 `...process.env` 展開會把這個旗標原樣傳給底下 spawn 出來的子行程，讓子行程誤判成
  // 「重入」而完全跳過搶鎖，整批 lease 測試的前提就不成立了。所有子行程一律先清掉這個變數，
  // 確定是乾淨狀態才疊加測試自己要覆寫的值。
  function scrubEnv(extra = {}) {
    const env = { ...process.env };
    delete env.CONSTELLATION_LEASE_ACQUIRED; // 先清掉繼承來的舊值……
    return { ...env, ...extra }; // ……測試自己要覆寫的值再疊上去，不會被這裡誤刪
  }

  // proj：假持有者代表哪個專案（預設 leaseProj）；legacyDir：登記到舊版目錄名（例如 'machine'）。
  function spawnFakeHolder(holdMs, proj = leaseProj, legacyDir) {
    const child = spawn(process.execPath, [fakeHolderScript, String(holdMs), proj, ...(legacyDir ? [legacyDir] : [])], {
      env: scrubEnv({ USERPROFILE: leaseHome, HOME: leaseHome }),
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.holderFile = holderFilePath(proj, legacyDir); // 收工清理用：記下它登記在哪
    return child;
  }

  function readHolderRaw(proj = leaseProj, legacyDir) {
    try { return JSON.parse(readFileSync(holderFilePath(proj, legacyDir), 'utf8')); } catch { return null; }
  }

  // 等到「這個假持有者自己的 pid」真的出現在登記檔裡才算數——不能只看檔案存不存在：上一個案例
  // 被 killFakeHolder 殺掉的假持有者若清理失敗會留下一份舊登記，光憑「有檔案」會誤判成這一輪剛
  // 搶到的那份，讓後面的斷言在錯的前提上跑。
  async function waitForHolderPid(pid, timeoutMs = 5000, proj = leaseProj, legacyDir) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const h = readHolderRaw(proj, legacyDir);
      if (h && Number(h.pid) === Number(pid)) return true;
      await new Promise(r => setTimeout(r, 20));
    }
    return false;
  }

  // 收工清掉測試自己模擬的假持有者：先比對登記確實是它（pid 相符）才刪，避免誤刪下一個案例
  // 剛搶到的登記；假持有者被 kill 後不會自己釋放，不清乾淨就會汙染下一個案例的起始狀態。
  function killFakeHolder(child) {
    try {
      const file = child.holderFile || holderFilePath();
      const h = JSON.parse(readFileSync(file, 'utf8'));
      if (h && Number(h.pid) === Number(child.pid)) rmSync(file, { force: true });
    } catch {}
    try { child.kill(); } catch {}
  }

  function cleanupShipArtifacts() {
    try { rmSync(join(leaseProj, '.constellation', 'ship-evidence.md'), { force: true }); } catch {}
    try { rmSync(join(leaseProj, '.constellation', '.verify-state.json'), { force: true }); } catch {}
  }

  function runShip(args = [], env = {}, cwd = leaseProj) {
    return spawnSync(process.execPath, [RUNNER, '--cwd', cwd, '--scope', 'ship', ...args], {
      env: scrubEnv({ USERPROFILE: leaseHome, HOME: leaseHome, ...env }),
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  test('無人佔用：直接搶到鎖、跑完、釋放——收工後登記檔不留痕（M2：一次就搶到也要印「開跑」）', () => {
    const r = runShip();
    assert.equal(r.status, 0, `應成功，實際 ${r.status}｜${r.stderr.slice(-300)}`);
    assert.equal(existsSync(holderFilePath()), false, '收工後機器鎖應已釋放，不留登記檔');
    assert.match(r.stderr, /開跑/, '沒人排隊時也要印出「開跑」，主 session 才有訊號判斷能不能中途砍');
    cleanupShipArtifacts();
  });

  test('機器鎖登記目錄寫不進去：fail-open 直接照跑，訊息也要講明「視為已開跑」（M2）', () => {
    // 讓 leaseDir() 的 mkdirSync 必然失敗：預先在 leases 這個路徑放一個檔案（不是目錄），
    // 底下的專案鍵子目錄就無論如何建不出來。用獨立的假家目錄，不影響其他案例共用的 leaseHome。
    const failHome = mkdtempSync(join(tmpdir(), 'vr-lease-failopen-'));
    try {
      mkdirSync(join(failHome, '.constellation'), { recursive: true });
      writeFileSync(join(failHome, '.constellation', 'leases'), '不是目錄，卡住 mkdir', 'utf8');
      const r = spawnSync(process.execPath, [RUNNER, '--cwd', leaseProj, '--scope', 'ship'], {
        env: scrubEnv({ USERPROFILE: failHome, HOME: failHome }),
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(r.status, 0, `寫不進去仍要 fail-open 照跑，實際 ${r.status}｜${r.stderr.slice(-300)}`);
      assert.match(r.stderr, /機器鎖登記目錄寫不進去/, '應印出 fail-open 警告');
      assert.match(r.stderr, /開跑/, 'fail-open 訊息也要含「開跑」——這條路徑同樣是「已經開始跑」');
      cleanupShipArtifacts();
    } finally {
      try { rmSync(failHome, { recursive: true, force: true }); } catch {}
    }
  });

  test('持有者 pid 已死：零成本判定失效，不必等滿一輪 poll 就立刻接手', async () => {
    const dead = spawnFakeHolder(1);
    // 對抗審查 should-fix：exit Promise 要在 spawn 後立刻建立、掛上監聽器——holdMs=1 的假持有者
    // 幾乎立刻退場，若等 waitForHolderPid 那輪 poll 跑完才掛 on('exit')，子行程往往早就結束、
    // 事件已經發過，這個 Promise 永遠不會 resolve（機器負載高時會直接卡死整個測試檔）。
    const exited = new Promise(resolve => dead.once('exit', resolve));
    assert.ok(await waitForHolderPid(dead.pid), '假持有者應登記到自己的 pid');
    await exited;
    assert.ok(existsSync(holderFilePath()), '假持有者應留下登記檔（它不會自己清）');

    const start = Date.now();
    const r = runShip();
    const elapsedMs = Date.now() - start;
    assert.equal(r.status, 0, `應成功接手並跑完，實際 ${r.status}｜${r.stderr.slice(-300)}`);
    assert.match(r.stderr, /原持有者已失效，機器鎖搶到了/, '應印出接手訊息');
    assert.ok(elapsedMs < 15_000, `pid 已死應零成本判定、不必排隊重試，實際耗時 ${elapsedMs}ms`);
    cleanupShipArtifacts();
  });

  // 對齊 phase-ship.md 步驟 1 的措辭契約：「排隊中（尚未印出「開跑」那一行）可以先停掉…一旦印出
  // 「開跑」就不准中途砍」——這條印線是主 session 判斷能不能中途砍的訊號，不能只在「持有者判定
  // 失效」那條路徑印，持有者正常跑完、release() 自然釋放交棒的這條路徑（acquireShipLease 的
  // `!holder` 分支）也要印，否則排隊等到真的輪到自己開跑時反而靜默無聲。這裡用兩個真的
  // verify-runner.mjs --scope ship 行程（不是假持有者腳本）：A 真的跑完、真的在 process.exit 呼叫
  // release() 釋放鎖，B 排隊等它——比假持有者腳本（設 timeout 直接死掉、不釋放）更貼近真實交棒。
  // 決議 033：A 與 B 要排隊，必須是同一個專案——這裡 B 在同一個 repo 的另一個 worktree 裡跑
  // （同 repo 的各 worktree 算同一專案，鍵是主工作樹根；這同時驗了「同 repo 不同 worktree 視為同專案」）。
  test('持有者正常跑完釋放（非判失效）：同專案另一個 worktree 的 B 排隊接手時也要印出「開跑」交接訊息，不能靜默', async () => {
    // A 的全量刻意跑一段有感時間，讓 B 有機會先觀察到「排隊等待」，再等 A 正常收尾釋放而非判死。
    const projA = makeMainProject('vr-lease-projA-', { test: ['node -e "setTimeout(()=>process.exit(0),600)"'], journey: [] });
    const projB = makeWorktreeOf(projA, 'vr-lease-projB-');
    let a;
    try {
      a = spawn(process.execPath, [RUNNER, '--cwd', projA, '--scope', 'ship'], {
        env: { ...process.env, USERPROFILE: leaseHome, HOME: leaseHome },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      assert.ok(await waitForHolderPid(a.pid, 5000, projA), 'A 應該先搶到本專案的出貨鎖並登記自己的 pid');
      assert.equal(projectKey(projB), projectKey(projA), '前提：B 的 worktree 與 A 是同一專案');

      const b = runShip(['--max-wait', '20'], { CONSTELLATION_LEASE_TEST_POLL_MS: '100' }, projB);
      assert.equal(b.status, 0, `B 應排隊等 A 釋放後接手成功，實際 ${b.status}｜${b.stderr.slice(-300)}`);
      assert.match(b.stderr, /機器鎖被佔用，排隊等待/, 'B 應先印排隊訊息');
      assert.match(b.stderr, /機器鎖搶到了，開跑/, 'A 正常收尾釋放後，B 接手時應印出「開跑」交接訊息（不能靜默接手）');
      assert.doesNotMatch(b.stderr, /原持有者已失效/, 'A 是正常收尾釋放（release），不是判定失效（invalidate），訊息不該講成失效');
    } finally {
      try { a && a.kill(); } catch {}
      for (const d of [projA, projB]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
    }
  });

  test('持有者活著但比預期早退場：B 排隊等，A 結束後很快接手（poll 間隔覆寫成 200ms）', async () => {
    const holder = spawnFakeHolder(1200);
    assert.ok(await waitForHolderPid(holder.pid), '假持有者應登記到自己的 pid');

    const start = Date.now();
    const r = runShip([], { CONSTELLATION_LEASE_TEST_POLL_MS: '200' });
    const elapsedMs = Date.now() - start;
    assert.equal(r.status, 0, `應成功接手並跑完，實際 ${r.status}｜${r.stderr.slice(-300)}`);
    assert.match(r.stderr, /機器鎖被佔用，排隊等待/, '應印出排隊訊息');
    // 假持有者活約 1.2 秒、poll 間隔 200ms，理論上很快就會接手；上限給寬鬆很多，這裡驗證的是
    // 「真的會接手」而非精確計時——本機這類黑箱 spawn 測試單次就可能吃到數秒的行程建立開銷。
    assert.ok(elapsedMs < 25_000, `排隊等待應該接手成功，實際耗時 ${elapsedMs}ms`);
    cleanupShipArtifacts();
  });

  test('--scope ticket 不搶鎖：持有方存在時只印一行提醒，逐票驗證照跑不受影響', async () => {
    const holder = spawnFakeHolder(3000);
    try {
      assert.ok(await waitForHolderPid(holder.pid), '假持有者應登記到自己的 pid');

      writeFileSync(join(leaseProj, '.constellation', 'tickets', 'T-801-ticket.md'), [
        '---', 'status: in-progress', '---', '# T-801 ticket', '',
        '## 驗收條件', '- [x] 條件一', '',
        '## 決議記錄', '',
        '## 驗證指令',
        '- `node -e "process.exit(0)"`',
        '',
        '## 驗證證據（關票時由 runner 寫入）', '',
      ].join('\n'), 'utf8');

      const r = spawnSync(process.execPath, [RUNNER, '--cwd', leaseProj, '--ticket', 'T-801-ticket', '--scope', 'ticket'], {
        env: scrubEnv({ USERPROFILE: leaseHome, HOME: leaseHome }),
        encoding: 'utf8',
        timeout: 25_000,
      });
      assert.equal(r.status, 0, `逐票驗證不該被機器鎖擋住，實際 ${r.status}｜${r.stderr.slice(-300)}`);
      // S7：規格要求「一行」且要帶「紅了怎麼辦」的行動指引，不是印一整份 formatHolder 摘要。
      const reminderLine = r.stderr.split('\n').find(l => l.includes('提醒：出貨鎖目前被別的出貨全量持有中'));
      assert.ok(reminderLine, '應印出提醒');
      assert.match(reminderLine, /先等對方結束再單跑紅的那幾支判定/, '提醒應包含紅了之後的行動指引');
      assert.equal(existsSync(holderFilePath()), true, '逐票驗證不該動到別人的出貨鎖登記');
      const holderNow = readHolderRaw();
      assert.equal(holderNow && Number(holderNow.pid), holder.pid, '出貨鎖仍應是原本那個假持有者，未被逐票驗證誤搶或誤清');
    } finally {
      killFakeHolder(holder);
      try { rmSync(join(leaseProj, '.constellation', 'tickets', 'T-801-ticket.md'), { force: true }); } catch {}
    }
  });

  test('子孫重入（環境變數帶正確身分 pid:startedAt）：不再搶鎖也不等待，直接照跑（S6）', async () => {
    const holder = spawnFakeHolder(5000); // 用夠長的存活時間，確保不會在檢查完前自然結束
    try {
      assert.ok(await waitForHolderPid(holder.pid), '假持有者應登記到自己的 pid');
      const h = readHolderRaw();
      const flag = `${h.pid}:${h.startedAt}`; // 規格要求的「識別碼」，不是單純的 '1'

      const r = runShip([], { CONSTELLATION_LEASE_ACQUIRED: flag });
      assert.equal(r.status, 0, `重入應直接照跑，實際 ${r.status}｜${r.stderr.slice(-300)}`);
      assert.doesNotMatch(r.stderr, /機器鎖被佔用，排隊等待/, '重入不該印排隊訊息');
      const holderNow = readHolderRaw();
      assert.equal(holderNow && Number(holderNow.pid), holder.pid, '重入不該碰別人的登記，鎖應該還是原本那個假持有者的');
      cleanupShipArtifacts();
    } finally {
      killFakeHolder(holder);
    }
  });

  test('環境變數只是繼承到的無關值（不是目前持有者的身分）：不算重入，照常排隊搶鎖（S6）', async () => {
    // 對抗複審 S6 的核心重現案例：舊實作只看這個變數存不存在（放 '1' 就跳過搶鎖），任何單純繼承到
    // 這個變數的行程都會被誤判成子孫。修正後必須是「目前登記持有者的 pid:startedAt」才算數。
    const holder = spawnFakeHolder(1500);
    try {
      assert.ok(await waitForHolderPid(holder.pid), '假持有者應登記到自己的 pid');
      const r = runShip(['--max-wait', '10'], { CONSTELLATION_LEASE_ACQUIRED: '1', CONSTELLATION_LEASE_TEST_POLL_MS: '200' });
      assert.equal(r.status, 0, `不是自己身分的旗標不該被當成重入，應該照常排隊接手，實際 ${r.status}｜${r.stderr.slice(-300)}`);
      assert.match(r.stderr, /機器鎖被佔用，排隊等待/, '不算重入時應該照常印出排隊訊息，不能靜默跳過搶鎖');
      cleanupShipArtifacts();
    } finally {
      killFakeHolder(holder);
    }
  });

  test('--max-wait 逾時：機器鎖一直被佔用，用代碼 3 結束，不計入斷路器、不寫失敗紀錄', async () => {
    const holder = spawnFakeHolder(60_000); // 撐過整個測試視窗，確定不會在等待期間自然死亡
    try {
      assert.ok(await waitForHolderPid(holder.pid), '假持有者應登記到自己的 pid');
      assert.equal(existsSync(join(leaseProj, '.constellation', '.verify-state.json')), false, '測試前提：斷路器計數檔本來就不存在');

      const r = runShip(['--max-wait', '1'], { CONSTELLATION_LEASE_TEST_POLL_MS: '200' });
      assert.equal(r.status, 3, `逾時應以代碼 3 結束，實際 ${r.status}｜${r.stderr.slice(-300)}`);
      assert.match(r.stderr, /等了 \d+ 分鐘機器鎖仍被佔用/, '應印出逾時訊息');
      assert.equal(existsSync(join(leaseProj, '.constellation', '.verify-state.json')), false, '逾時不該碰斷路器計數檔');
      assert.equal(existsSync(join(leaseProj, '.constellation', 'ship-evidence.md')), false, '逾時不該寫任何證據或失敗紀錄');
    } finally {
      killFakeHolder(holder);
    }
  });

  test('登記檔壞掉（0 位元組，讀不出來但檔案還在）：不會靜默卡滿 max-wait，逾時前會先印訊息（S2）', () => {
    mkdirSync(dirname(holderFilePath()), { recursive: true });
    writeFileSync(holderFilePath(), '', 'utf8'); // 模擬寫到一半被打斷留下的空檔
    try {
      const r = runShip(['--max-wait', '1'], { CONSTELLATION_LEASE_TEST_POLL_MS: '200' });
      assert.equal(r.status, 3, `應以代碼 3 逾時結束，實際 ${r.status}｜${r.stderr.slice(-300)}`);
      assert.match(r.stderr, /讀不出來/, '不能一個字都不印——舊版這裡完全靜默，只能乾等到 max-wait');
    } finally {
      try { rmSync(holderFilePath(), { force: true }); } catch {}
    }
  });

  test('登記檔壞掉超過門檻：視同失效並清掉，之後能正常搶到鎖、印出開跑（S2）', () => {
    mkdirSync(dirname(holderFilePath()), { recursive: true });
    writeFileSync(holderFilePath(), '{ 這不是合法 JSON', 'utf8');
    try {
      // 用測試逃生窗把「卡多久才當失效」壓到 300ms，不必真的等 30 秒。
      const r = runShip([], { CONSTELLATION_LEASE_TEST_POLL_MS: '100', CONSTELLATION_LEASE_TEST_CORRUPT_STALE_MS: '300' });
      assert.equal(r.status, 0, `壞掉的登記過了門檻後應能正常接手跑完，實際 ${r.status}｜${r.stderr.slice(-300)}`);
      assert.match(r.stderr, /讀不出來/, '應先印出壞掉訊息');
      assert.match(r.stderr, /機器鎖搶到了，開跑/, '門檻過後應正常接手並印出開跑訊息');
      cleanupShipArtifacts();
    } finally {
      try { rmSync(holderFilePath(), { force: true }); } catch {}
      try { rmSync(`${holderFilePath()}.stale`, { force: true }); } catch {}
    }
  });

  test('失效改名一直失敗（目標路徑被卡住）：仍會遵守 --max-wait，不會無限空轉（S3）', async () => {
    const dead = spawnFakeHolder(1);
    // 對抗審查 should-fix：理由同前一個案例，exit Promise 要在 spawn 後立刻建立、掛上監聽器。
    const exited = new Promise(resolve => dead.once('exit', resolve));
    assert.ok(await waitForHolderPid(dead.pid), '假持有者應登記到自己的 pid');
    await exited;
    assert.ok(existsSync(holderFilePath()), '假持有者應留下登記檔（它不會自己清）');

    // 卡住失效改名：在 invalidate() 要 rename 過去的路徑上預先放一個目錄，rename 會一直失敗。
    const staleDir = `${holderFilePath()}.stale`;
    mkdirSync(staleDir, { recursive: true });
    try {
      const start = Date.now();
      const r = runShip(['--max-wait', '2'], { CONSTELLATION_LEASE_TEST_POLL_MS: '200' });
      const elapsedMs = Date.now() - start;
      assert.equal(r.status, 3, `應以代碼 3 逾時結束，不是無限空轉，實際 ${r.status}｜${r.stderr.slice(-300)}`);
      assert.ok(elapsedMs < 15_000, `不該無限空轉，實際耗時 ${elapsedMs}ms`);
      assert.match(r.stderr, /等了 \d+ 分鐘機器鎖仍被佔用/, '應印出逾時訊息');
    } finally {
      try { rmSync(staleDir, { recursive: true, force: true }); } catch {}
      // 這個案例刻意讓失效改名失敗，假持有者的（已死）登記因此一直留在本專案的鍵底下——收掉，免得汙染後面的案例。
      try { rmSync(holderFilePath(), { force: true }); } catch {}
    }
  });

  test('session／runtime 取值優先序：兩個 session id 都在時以 CODEX_SESSION_ID 為準（S9）', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'vr-lease-sess-'));
    let child;
    try {
      mkdirSync(join(proj, '.constellation', 'tickets'), { recursive: true });
      writeFileSync(join(proj, '.constellation', 'config.json'), JSON.stringify({
        commands: { test: ['node -e "setTimeout(()=>process.exit(0),800)"'], journey: [] },
      }), 'utf8');
      child = spawn(process.execPath, [RUNNER, '--cwd', proj, '--scope', 'ship'], {
        env: scrubEnv({
          USERPROFILE: leaseHome, HOME: leaseHome,
          CLAUDE_CODE_SESSION_ID: 'outer-claude', CODEX_SESSION_ID: 'inner-codex',
        }),
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      // 對抗審查 should-fix：exit Promise 要在 spawn 後立刻建立——這裡子行程活 800ms，一般情況下
      // waitForHolderPid 早就完成，但機器負載高時 poll 可能拖久，晚掛監聽器一樣會踩到同一個競態。
      const exited = new Promise(r => child.once('exit', r));
      assert.ok(await waitForHolderPid(child.pid, 5000, proj), '應該搶到鎖並登記');
      const holder = readHolderRaw(proj);
      assert.equal(holder.session, 'inner-codex', 'Codex 從 Claude Code 內被啟動時，兩個 session id 都在，應以 CODEX_SESSION_ID 為準');
      assert.equal(holder.runtime, 'codex');
      assert.equal(holder.key, projectKey(proj), '登記要帶專案鍵（殺行程守門比對 cwd 用）');
      await exited;
    } finally {
      try { child && child.kill(); } catch {}
      try { rmSync(proj, { recursive: true, force: true }); } catch {}
    }
  });

  // ── 決議 033：只有同專案才排隊；別的專案持有只提醒、不等 ──
  test('跨專案不等：別的專案的出貨鎖有人持有（活著），本專案照樣直接開跑，不印排隊訊息、不碰對方的登記，並印提醒', async () => {
    const otherProj = makeMainProject('vr-lease-other-');
    const holder = spawnFakeHolder(60_000, otherProj);
    try {
      assert.ok(await waitForHolderPid(holder.pid, 5000, otherProj), '別專案的假持有者應登記到自己的鍵底下');

      const start = Date.now();
      const r = runShip(['--max-wait', '5']);
      const elapsedMs = Date.now() - start;
      assert.equal(r.status, 0, `跨專案不該被擋，應直接跑完，實際 ${r.status}｜${r.stderr.slice(-300)}`);
      assert.ok(elapsedMs < 20_000, `不該排隊等待，實際耗時 ${elapsedMs}ms`);
      assert.doesNotMatch(r.stderr, /機器鎖被佔用，排隊等待/, '別專案持有不該讓本專案排隊');
      assert.match(r.stderr, /開跑/, '照常印「開跑」');
      const reminderLine = r.stderr.split('\n').find(l => l.includes('提醒：出貨鎖目前被別的出貨全量持有中'));
      assert.ok(reminderLine, '開跑時要提醒別專案的出貨鎖有人持有');
      assert.ok(reminderLine.includes(otherProj), '提醒要點名對方的專案');
      assert.equal(Number(readHolderRaw(otherProj).pid), holder.pid, '對方的登記不該被動到');
      assert.equal(existsSync(holderFilePath()), false, '本專案收工後釋放自己那一份');
      cleanupShipArtifacts();
    } finally {
      killFakeHolder(holder);
      try { rmSync(otherProj, { recursive: true, force: true }); } catch {}
    }
  });

  test('跨專案、紅燈收尾：別專案的出貨鎖還有人持有，開跑與紅燈收尾各提醒一次（先等對方結束再單跑判定）', async () => {
    const otherProj = makeMainProject('vr-lease-other-');
    const redProj = makeMainProject('vr-lease-red-', { test: ['node -e "process.exit(1)"'], journey: [] });
    const holder = spawnFakeHolder(60_000, otherProj);
    try {
      assert.ok(await waitForHolderPid(holder.pid, 5000, otherProj));
      const r = runShip([], {}, redProj);
      assert.equal(r.status, 1, `應紅燈 exit 1，實際 ${r.status}｜${r.stderr.slice(-300)}`);
      assert.doesNotMatch(r.stderr, /機器鎖被佔用，排隊等待/);
      const reminders = r.stderr.split('\n').filter(l => l.includes('提醒：出貨鎖目前被別的出貨全量持有中'));
      assert.equal(reminders.length, 2, `開跑一次、紅燈收尾一次，實際 ${reminders.length} 次`);
      for (const line of reminders) assert.match(line, /先等對方結束再單跑紅的那幾支判定/, "開跑與紅燈收尾兩次提醒都要帶單跑指引");
      assert.ok(r.stderr.lastIndexOf('提醒：出貨鎖') > r.stderr.indexOf('驗證失敗'), '收尾那次提醒要印在失敗訊息之後');
      cleanupFailureLog(r.stderr);
    } finally {
      killFakeHolder(holder);
      for (const d of [otherProj, redProj]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
    }
  });

  test('沒有別人持有時紅燈收尾不印提醒（也不誤把自己的登記當成別人）', () => {
    const redProj = makeMainProject('vr-lease-red-', { test: ['node -e "process.exit(1)"'], journey: [] });
    try {
      const r = runShip([], {}, redProj);
      assert.equal(r.status, 1);
      assert.doesNotMatch(r.stderr, /提醒：出貨鎖/);
      cleanupFailureLog(r.stderr);
    } finally {
      try { rmSync(redProj, { recursive: true, force: true }); } catch {}
    }
  });

  test('相容舊版：leases/machine 的舊登記不讓新版排隊（不是同專案的鍵），但提醒讀得到它', async () => {
    const holder = spawnFakeHolder(60_000, 'C:/legacy-project-root', 'machine');
    try {
      assert.ok(await waitForHolderPid(holder.pid, 5000, undefined, 'machine'), '舊版 machine 登記應寫在 leases/machine/holder.json');
      assert.equal(readHolderRaw(undefined, 'machine').key, undefined, '前提：舊登記沒有 key 欄位');

      const r = runShip(['--max-wait', '5']);
      assert.equal(r.status, 0, `舊登記不該讓新版排隊，實際 ${r.status}｜${r.stderr.slice(-300)}`);
      assert.doesNotMatch(r.stderr, /機器鎖被佔用，排隊等待/);
      assert.match(r.stderr, /提醒：出貨鎖目前被別的出貨全量持有中（C:\/legacy-project-root/, '提醒要讀得到舊版登記');
      assert.equal(Number(readHolderRaw(undefined, 'machine').pid), holder.pid, '舊登記不該被動到');
      cleanupShipArtifacts();
    } finally {
      killFakeHolder(holder);
    }
  });

  test('同專案的兩個 worktree：持有者在主工作樹，另一個 worktree 的 runner 照樣要排隊（逾時代碼 3）', async () => {
    const mainProj = makeMainProject('vr-lease-main-');
    const wt = makeWorktreeOf(mainProj, 'vr-lease-wt-');
    const holder = spawnFakeHolder(60_000, mainProj);
    try {
      assert.ok(await waitForHolderPid(holder.pid, 5000, mainProj));
      const r = runShip(['--max-wait', '1'], { CONSTELLATION_LEASE_TEST_POLL_MS: '200' }, wt);
      assert.equal(r.status, 3, `同專案應排隊到逾時，實際 ${r.status}｜${r.stderr.slice(-300)}`);
      assert.match(r.stderr, /機器鎖被佔用，排隊等待/);
    } finally {
      killFakeHolder(holder);
      for (const d of [mainProj, wt]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
    }
  });
});
