// gates/test/close-gate.test.mjs — 關票刷卡機黑箱回歸：close-gate.mjs 檔尾無條件掛 stdin／執行
// main（沒有 import.meta.url 守衛），import 就會搶先 exit，只能 spawn 子行程餵 stdin JSON。
//
// P3（### P3）：close-gate 目前拿「hook payload 的 cwd」直接當專案根去驗簽章／找 design-frozen.json／
// design-baseline.json——session 在子目錄、或主線 cwd 在另一個 worktree而要改的票在別處時，算出來的
// repoRootToken 對不上、或往錯的目錄找名單，導致「合法證據被判竄改」或「凍結／baseline 檢查靜默失效
// （fail-open）」。改法：一律從「要改的那個檔」推根，不依賴 cwd。下面用同一批合法證據／同一份
// frozen／baseline，只換 cwd（根／子目錄／另一個 worktree），驗證改後三種 cwd 都得到同一個結果。
//
// P24（### P24）：拿掉 MultiEdit 死分支（現行 46 支工具已無 MultiEdit、Codex 只送 apply_patch），
// 並用 Write／Edit／apply_patch × 凍結／baseline／done 三種檢查各驗一輪，確認拿掉死碼後三個工具、
// 三種檢查的既有行為都還在（純刪除，不改行為）。
//
// 對抗審查 must-fix（P3 殘留）：findProjectRoot 舊寫法認 `.constellation/config.json`，但 config.json
// 要到 weave 階段才生成、畫面定稿凍結卻發生在更早的 design 階段——新專案第一輪（有 .constellation
// 目錄、有 design-baseline.json／design-frozen.json，但還沒有 config.json）會把根找錯，導致合法的
// 定稿凍結被誤判成「baseline 不存在」而擋下、凍結守衛也會讀錯位置而 fail-open。下面用一個沒有
// config.json 的專案，驗證改後這兩條路徑都恢復正常。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'close-gate.mjs');

// ── 簽章 helper：與 close-gate.mjs 的 computeSignature／ticketRelPath／repoRootToken 逐字元一致
// （見該檔檔頭「鏡像提醒」），這裡獨立重算一份純粹用來造假證據 fixture，不 import 閘門本身的函式。
const FIELD_SEP = '\u0001';
function ticketRelPath(p) {
  const norm = String(p).replace(/\\/g, '/');
  const m = norm.match(/\.constellation\/tickets\/[^/]+\.md$/i);
  return m ? m[0] : norm;
}
function repoRootToken(cwd) {
  return resolve(cwd).toLowerCase().replace(/\\/g, '/');
}
function sign(secret, ts, relPath, commandsJoined, lastLine, repoRoot) {
  const payload = [ts, relPath, commandsJoined, lastLine, repoRoot].join(FIELD_SEP);
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

const SECRET = 'test-secret-close-gate';
const CMD = `node -e "console.log('all green')"`;
const OUT_LINE = 'all green';

// 造一筆「repoRoot 這個專案根底下、簽章對得上」的合法證據票檔內容。
function ticketWithEvidence({ repoRoot, filePath, status = 'done' }) {
  const ts = new Date().toISOString();
  const rel = ticketRelPath(filePath);
  const sig = sign(SECRET, ts, rel, CMD, OUT_LINE, repoRootToken(repoRoot));
  return [
    '---', `status: ${status}`, '---',
    '# T-001 demo', '',
    '## 驗收條件', '- [x] 條件一', '',
    '## 決議記錄', '',
    '## 驗證證據（關票時由 runner 寫入）',
    `- **${ts}**`,
    `  - \`${CMD}\`（exit 0）`,
    '    ```',
    `    ${OUT_LINE}`,
    '    ```',
    `  - sig: ${sig}`,
    '',
  ].join('\n');
}

function ticketNoEvidence(status = 'in-progress') {
  return ['---', `status: ${status}`, '---', '# T-002 noevid', '', '## 驗收條件', '- [x] 條件一', '', '## 驗證證據（關票時由 runner 寫入）', ''].join('\n');
}

let fakeHome, projRoot, projRootNoBaseline, projRootNoConfig, T1, T1_nb, T2, FZ, FZ_nb, FZ_nc, PAGE, PAGE_nb, PAGE_nc, subDir, anotherWorktree, nonProjectFile;

before(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'cgate-home-'));
  mkdirSync(join(fakeHome, '.constellation'), { recursive: true });
  writeFileSync(join(fakeHome, '.constellation', 'secret'), SECRET, 'utf8');

  // 專案 A：有 design-baseline.json（過關用）。
  projRoot = mkdtempSync(join(tmpdir(), 'cgate-proj-'));
  mkdirSync(join(projRoot, '.constellation', 'tickets'), { recursive: true });
  mkdirSync(join(projRoot, 'web', 'src'), { recursive: true });
  mkdirSync(join(projRoot, 'sub'), { recursive: true });
  T1 = join(projRoot, '.constellation', 'tickets', 'T-001-demo.md');
  T2 = join(projRoot, '.constellation', 'tickets', 'T-002-noevid.md');
  FZ = join(projRoot, '.constellation', 'design-frozen.json');
  PAGE = join(projRoot, 'web', 'src', 'Page.tsx');
  writeFileSync(join(projRoot, '.constellation', 'config.json'), '{}', 'utf8'); // findProjectRoot 認這個檔存在
  writeFileSync(T1, ticketWithEvidence({ repoRoot: projRoot, filePath: T1 }), 'utf8');
  writeFileSync(T2, ticketNoEvidence(), 'utf8');
  writeFileSync(FZ, JSON.stringify({ frozen: ['web/src/Page.tsx'], source: 'test', log: [] }), 'utf8');
  writeFileSync(join(projRoot, '.constellation', 'design-baseline.json'), JSON.stringify({ screens: [{ screen: 'Page', kind: 'new' }] }), 'utf8');
  writeFileSync(PAGE, '<div>1</div>', 'utf8');
  subDir = join(projRoot, 'sub');

  // 專案 B：跟 A 結構相同但**沒有** design-baseline.json（驗 baseline 缺失擋下用）。
  projRootNoBaseline = mkdtempSync(join(tmpdir(), 'cgate-proj-nb-'));
  mkdirSync(join(projRootNoBaseline, '.constellation', 'tickets'), { recursive: true });
  mkdirSync(join(projRootNoBaseline, 'web', 'src'), { recursive: true });
  T1_nb = join(projRootNoBaseline, '.constellation', 'tickets', 'T-001-demo.md');
  FZ_nb = join(projRootNoBaseline, '.constellation', 'design-frozen.json');
  PAGE_nb = join(projRootNoBaseline, 'web', 'src', 'Page.tsx');
  writeFileSync(join(projRootNoBaseline, '.constellation', 'config.json'), '{}', 'utf8');
  writeFileSync(T1_nb, ticketWithEvidence({ repoRoot: projRootNoBaseline, filePath: T1_nb }), 'utf8');
  writeFileSync(FZ_nb, JSON.stringify({ frozen: ['web/src/Page.tsx'], source: 'test', log: [] }), 'utf8');
  writeFileSync(PAGE_nb, '<div>1</div>', 'utf8');

  // 專案 C：跟 A 結構相同（有合法 baseline、有 frozen 名單），但**沒有 config.json**——模擬新專案
  // 第一輪 design 階段（config.json 要到 weave 才生成，見 P3 殘留說明）。
  projRootNoConfig = mkdtempSync(join(tmpdir(), 'cgate-proj-nc-'));
  mkdirSync(join(projRootNoConfig, 'web', 'src'), { recursive: true });
  FZ_nc = join(projRootNoConfig, '.constellation', 'design-frozen.json');
  PAGE_nc = join(projRootNoConfig, 'web', 'src', 'Page.tsx');
  mkdirSync(join(projRootNoConfig, '.constellation'), { recursive: true });
  writeFileSync(FZ_nc, JSON.stringify({ frozen: ['web/src/Page.tsx'], source: 'test', log: [] }), 'utf8');
  writeFileSync(join(projRootNoConfig, '.constellation', 'design-baseline.json'), JSON.stringify({ screens: [{ screen: 'Page', kind: 'new' }] }), 'utf8');
  writeFileSync(PAGE_nc, '<div>1</div>', 'utf8');

  // 「另一個 worktree」：跟 projRoot 完全無關的另一個目錄，只拿它的路徑當 cwd 用——
  // 要改的檔仍是 projRoot 底下的絕對路徑，模擬「主線 cwd 在別的 worktree，票在別處」。
  anotherWorktree = mkdtempSync(join(tmpdir(), 'cgate-otherwt-'));

  // 「家目錄非專案」：家目錄底下一個完全不相關、沒有任何 .constellation 祖先的檔案。
  mkdirSync(join(fakeHome, 'Documents', 'scratch-nonproject'), { recursive: true });
  nonProjectFile = join(fakeHome, 'Documents', 'scratch-nonproject', 'random.txt');
  writeFileSync(nonProjectFile, 'hello', 'utf8');
});

after(() => {
  for (const d of [fakeHome, projRoot, projRootNoBaseline, projRootNoConfig, anotherWorktree]) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

function runGate(input) {
  const r = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify(input),
    env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome },
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr || '' };
}

function assertPass(input, label) {
  const r = runGate(input);
  assert.equal(r.status, 0, `${label}：應放行（exit 0），實際 exit ${r.status}｜${r.stderr.slice(0, 200)}`);
}
function assertBlock(input, label, msgSubstr) {
  const r = runGate(input);
  assert.equal(r.status, 2, `${label}：應擋下（exit 2），實際 exit ${r.status}｜${r.stderr.slice(0, 200)}`);
  if (msgSubstr) assert.match(r.stderr, msgSubstr, `${label}：擋下訊息應含「${msgSubstr}」，實際：${r.stderr}`);
}

describe('close-gate：P3——根目錄推導不能被 cwd 帶偏（子目錄／另一個 worktree／家目錄非專案）', () => {
  test('done 票驗簽，cwd=專案根 → 放行（對照組）', () =>
    assertPass({ tool_name: 'Edit', cwd: projRoot, tool_input: { file_path: T1, old_string: 'x', new_string: 'status: done' } }, 'done@root'));

  test('done 票驗簽，cwd=專案子目錄 → 放行（根一律從票檔路徑推，不依賴 cwd）', () =>
    assertPass({ tool_name: 'Edit', cwd: subDir, tool_input: { file_path: T1, old_string: 'x', new_string: 'status: done' } }, 'done@subdir'));

  test('done 票驗簽，cwd=另一個 worktree → 放行（同上，root 不受錯誤 cwd 影響）', () =>
    assertPass({ tool_name: 'Edit', cwd: anotherWorktree, tool_input: { file_path: T1, old_string: 'x', new_string: 'status: done' } }, 'done@otherworktree'));

  test('凍結檔編輯，cwd=專案根 → 擋下（對照組）', () =>
    assertBlock({ tool_name: 'Edit', cwd: projRoot, tool_input: { file_path: PAGE, old_string: '1', new_string: '2' } }, 'frozen@root', /凍結守衛/));

  test('凍結檔編輯，cwd=專案子目錄 → 擋下（root 從目標檔目錄往上找，錯誤 cwd 不能讓凍結檢查 fail-open）', () =>
    assertBlock({ tool_name: 'Edit', cwd: subDir, tool_input: { file_path: PAGE, old_string: '1', new_string: '2' } }, 'frozen@subdir', /凍結守衛/));

  test('凍結檔編輯，cwd=另一個 worktree → 擋下（同上）', () =>
    assertBlock({ tool_name: 'Edit', cwd: anotherWorktree, tool_input: { file_path: PAGE, old_string: '1', new_string: '2' } }, 'frozen@otherworktree', /凍結守衛/));

  test('定稿凍結（baseline 存在且合法），cwd=專案根 → 放行（對照組）', () =>
    assertPass({ tool_name: 'Write', cwd: projRoot, tool_input: { file_path: FZ, content: '{"frozen":["web/src/Page.tsx"]}' } }, 'baseline-ok@root'));

  test('定稿凍結（baseline 存在且合法），cwd=專案子目錄 → 放行（baseline 也從目標檔目錄往上找，不誤判不存在）', () =>
    assertPass({ tool_name: 'Write', cwd: subDir, tool_input: { file_path: FZ, content: '{"frozen":["web/src/Page.tsx"]}' } }, 'baseline-ok@subdir'));

  test('定稿凍結（baseline 存在且合法），cwd=另一個 worktree → 放行（同上）', () =>
    assertPass({ tool_name: 'Write', cwd: anotherWorktree, tool_input: { file_path: FZ, content: '{"frozen":["web/src/Page.tsx"]}' } }, 'baseline-ok@otherworktree'));

  test('家目錄非專案：改家目錄底下無任何 .constellation 祖先的檔案 → 放行（fail-open、不誤判、不崩潰）', () =>
    assertPass({ tool_name: 'Edit', cwd: fakeHome, tool_input: { file_path: nonProjectFile, old_string: 'hello', new_string: 'world' } }, 'nonproject@home'));

  test('沒有 config.json（design 階段第一輪）：定稿凍結（baseline 合法）仍要放行，不能誤判成 baseline 不存在', () =>
    assertPass({ tool_name: 'Write', cwd: projRootNoConfig, tool_input: { file_path: FZ_nc, content: '{"frozen":["web/src/Page.tsx"]}' } }, 'baseline-ok@no-config'));

  test('沒有 config.json（design 階段第一輪）：凍結檔編輯仍要擋下，不能因為根算錯而 fail-open', () =>
    assertBlock({ tool_name: 'Edit', cwd: projRootNoConfig, tool_input: { file_path: PAGE_nc, old_string: '1', new_string: '2' } }, 'frozen@no-config', /凍結守衛/));
});

describe('close-gate：P24——Write／Edit／apply_patch × 凍結／baseline／done 矩陣（拿掉 MultiEdit 死分支後行為不變）', () => {
  test('Write：done 票（合法證據）→ 放行', () => {
    const content = ticketWithEvidence({ repoRoot: projRoot, filePath: T1 });
    assertPass({ tool_name: 'Write', cwd: projRoot, tool_input: { file_path: T1, content } }, 'Write done ok');
  });
  test('Write：done 票但無證據 → 擋下', () => {
    const content = ticketNoEvidence('done');
    assertBlock({ tool_name: 'Write', cwd: projRoot, tool_input: { file_path: T2, content } }, 'Write done no-evidence', /沒有可辨識的證據筆/);
  });
  test('Write：凍結檔 → 擋下', () =>
    assertBlock({ tool_name: 'Write', cwd: projRoot, tool_input: { file_path: PAGE, content: '<div>2</div>' } }, 'Write frozen', /凍結守衛/));
  test('Write：定稿凍結但 baseline 缺失 → 擋下', () =>
    assertBlock({ tool_name: 'Write', cwd: projRootNoBaseline, tool_input: { file_path: FZ_nb, content: '{"frozen":["web/src/Page.tsx"]}' } }, 'Write baseline missing', /現況覆蓋閘門/));

  test('Edit：done 票（合法證據）→ 放行', () =>
    assertPass({ tool_name: 'Edit', cwd: projRoot, tool_input: { file_path: T1, old_string: 'x', new_string: 'status: done' } }, 'Edit done ok'));
  test('Edit：凍結檔 → 擋下', () =>
    assertBlock({ tool_name: 'Edit', cwd: projRoot, tool_input: { file_path: PAGE, old_string: '1', new_string: '2' } }, 'Edit frozen', /凍結守衛/));
  test('Edit：定稿凍結但 baseline 缺失 → 擋下', () =>
    assertBlock({ tool_name: 'Edit', cwd: projRootNoBaseline, tool_input: { file_path: FZ_nb, old_string: '"frozen":[', new_string: '"frozen":["x",' } }, 'Edit baseline missing', /現況覆蓋閘門/));

  test('apply_patch：done 票（合法證據，patch 文字放在 command 欄位）→ 放行', () => {
    const patch = `*** Update File: ${T1}\n@@\n-status: in-progress\n+status: done\n`;
    assertPass({ tool_name: 'apply_patch', cwd: projRoot, tool_input: { command: patch } }, 'apply_patch done ok');
  });
  test('apply_patch：done 票但票檔無證據 → 擋下', () => {
    const patch = `*** Update File: ${T2}\n@@\n-status: in-progress\n+status: done\n`;
    assertBlock({ tool_name: 'apply_patch', cwd: projRoot, tool_input: { command: patch } }, 'apply_patch done no-evidence', /沒有可辨識的證據筆/);
  });
  test('apply_patch：凍結檔 → 擋下', () => {
    const patch = `*** Update File: ${PAGE}\n@@\n-<div>1</div>\n+<div>2</div>\n`;
    assertBlock({ tool_name: 'apply_patch', cwd: projRoot, tool_input: { command: patch } }, 'apply_patch frozen', /凍結守衛/);
  });
  test('apply_patch：定稿凍結但 baseline 缺失 → 擋下', () => {
    const patch = `*** Update File: ${FZ_nb}\n@@\n-"frozen":[]\n+"frozen":["web/src/Page.tsx"]\n`;
    assertBlock({ tool_name: 'apply_patch', cwd: projRootNoBaseline, tool_input: { command: patch } }, 'apply_patch baseline missing', /現況覆蓋閘門/);
  });

  test('MultiEdit 輸入不再被特別驗證（工具集已無 MultiEdit，P24 拿掉死分支後直接放行）', () => {
    // 現行工具集已無 MultiEdit（Claude Code 46 支工具、Codex 只送 apply_patch），移除這段死碼純屬
    // 清理、不影響任何真實 runtime 行為；本例記錄「拿掉分支」這個可觀察的黑箱行為（不再驗證）。
    assertPass({
      tool_name: 'MultiEdit',
      cwd: projRoot,
      tool_input: { file_path: T2, edits: [{ old_string: 'status: in-progress', new_string: 'status: done' }] },
    }, 'MultiEdit removed-branch');
  });
});
