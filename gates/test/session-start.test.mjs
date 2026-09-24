// gates/test/session-start.test.mjs — 對抗審查 should-fix：P16 把 resolveRepoRoot 從呼叫兩次
// （buildSummary 內部一次、ensurePrecommit 一次）改成只解析一次、buildSummary／ensurePrecommit
// 共用同一個 root，這個改動完全沒有回歸網。session-start.mjs 檔尾無條件掛 stdin（沒有
// import.meta.url 守衛），只能黑箱 spawn 驗證最基本的兩個情境：非 Constellation 專案靜默放行、
// Constellation 專案正常注入且 pre-commit 只裝一次。
//
// 第二輪對抗複審 should-fix：測試會讀開發者本機的全域 git 設定——本機若設了全域 core.hooksPath，
// installPrecommit 會照正確邏輯回報 skipped=custom-hookspath，導致這裡的斷言失敗（產品程式碼本身沒
// 有錯，是測試依賴本機狀態）。用環境變數把子行程的全域/系統設定都指向空檔案隔離掉，user.name／
// user.email 仍在 repo 層級設定，不受影響。
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
  const emptyGlobalConfig = join(mkdtempSync(join(tmpdir(), 'ss-gitcfg-')), 'gitconfig');
  writeFileSync(emptyGlobalConfig, '', 'utf8');
  process.env.GIT_CONFIG_GLOBAL = emptyGlobalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';

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
  for (const d of [nonProj, proj, ...extraDirs]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

function run(cwd) {
  const r = spawnSync(process.execPath, [GATE], { input: JSON.stringify({ cwd }), cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '' };
}

// 決議 023 P6／P11／P20 的黑箱夾具：依需要組出一個最小 Constellation 專案。
// tickets/decisions 只需要「存在幾個檔」，內文不必寫實——buildDesignSentinel／buildDecisionsSection
// 都只驗檔案存在性與計數，不解析內文（除了 grill-close.md 的「是否需要 UI」標記）。
const extraDirs = [];
function makeProjectFixture({ tickets = [], grillCloseUI = null, decisionsCount = 0, mapContent = null, contextContent = null, frozen = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ss-fx-'));
  extraDirs.push(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  mkdirSync(join(dir, '.constellation', 'tickets'), { recursive: true });
  mkdirSync(join(dir, '.constellation', 'decisions'), { recursive: true });
  tickets.forEach((content, i) => writeFileSync(join(dir, '.constellation', 'tickets', `T-${i}.md`), content, 'utf8'));
  if (grillCloseUI) {
    writeFileSync(join(dir, '.constellation', 'decisions', 'grill-close.md'), `# grill-close\n是否需要 UI：${grillCloseUI}\n`, 'utf8');
  }
  for (let i = 1; i <= decisionsCount; i++) {
    writeFileSync(join(dir, '.constellation', 'decisions', `${String(i).padStart(3, '0')}-d.md`), `# ${i}\n背景：測試。\n`, 'utf8');
  }
  if (mapContent != null) writeFileSync(join(dir, '.constellation', 'MAP.md'), mapContent, 'utf8');
  if (contextContent != null) writeFileSync(join(dir, '.constellation', 'CONTEXT.md'), contextContent, 'utf8');
  if (frozen !== null) writeFileSync(join(dir, '.constellation', 'design-frozen.json'), JSON.stringify(frozen), 'utf8');
  return dir;
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

describe('session-start：決議 023 P6——design 定稿哨兵改認 tickets/ 有沒有票，不靠 decisions 檔名', () => {
  test('grill-close 記著需要 UI、tickets/ 已有票、design-frozen.json 不存在 → 印哨兵警示', () => {
    const dir = makeProjectFixture({ tickets: ['# T-1\nstatus: open\n'], grillCloseUI: '是（照既有架構做）' });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /design 定稿哨兵/);
    assert.match(ctx, /design-frozen\.json 不存在/);
  });

  test('grill-close 記著需要 UI，但 tickets/ 還沒有票（還沒過 weave）→ 不印，交給 weave 進場三驗', () => {
    const dir = makeProjectFixture({ tickets: [], grillCloseUI: '是（照既有架構做）' });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /design 定稿哨兵/);
  });

  // 對抗複審 S8：這支測試原本沒有上一輪留下的 design-final 決議，舊實作（靠 decisions 檔名判斷）
  // 跑這個 fixture 也會過，測不出真正要防的回歸。補一筆舊輪的 design-final 檔名，同時 tickets/
  // 仍是空的（本輪還沒過 weave）——舊實作會被檔名誤觸發（décisions 有定稿記錄→接著查
  // design-frozen.json 不存在→誤報），新實作只認 tickets/ 有無票，應該仍不印。
  test('tickets/ 還沒有票，但 decisions/ 留著上一輪的 design-final 記錄 → 仍不印（觸發條件認票，不是檔名）', () => {
    const dir = makeProjectFixture({ tickets: [], grillCloseUI: '是（照既有架構做）' });
    writeFileSync(join(dir, '.constellation', 'decisions', '075-design-final.md'), '# 075 design-final\n上一輪的定稿記錄。\n', 'utf8');
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /design 定稿哨兵/, '還沒過 weave（tickets 空）該交給 weave 三驗，不該被舊輪遺留的檔名誤觸發');
  });

  test('grill-close 記著不需要 UI，即使 tickets/ 有票、design-frozen.json 缺失 → 不適用，不印', () => {
    const dir = makeProjectFixture({ tickets: ['# T-1\nstatus: open\n'], grillCloseUI: '否' });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /design 定稿哨兵/);
  });

  test('design-frozen.json 的 frozen 是空陣列 → 印哨兵並點名空陣列', () => {
    const dir = makeProjectFixture({
      tickets: ['# T-1\nstatus: open\n'], grillCloseUI: '是（架構有得選）',
      frozen: { frozen: [], log: [] },
    });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /frozen 是空陣列/);
  });

  test('frozen 名單裡的路徑在 repo 找不到 → 印哨兵並點名路徑數', () => {
    const dir = makeProjectFixture({
      tickets: ['# T-1\nstatus: open\n'], grillCloseUI: '是（照既有架構做）',
      frozen: { frozen: ['no/such/file.jsx'], log: [] },
    });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /凍結名單有 1 個路徑在 repo 找不到/);
  });

  // 對抗複審 S3：build 期預授權解凍會讓 frozen 暫時變空陣列（合法在途狀態），不該被誤判成
  // 「定稿沒落地」。
  test('frozen 是空陣列，但 log 有在途解凍（unfreeze 還沒被 refreeze）→ 不印，這是本輪合法在途狀態', () => {
    const dir = makeProjectFixture({
      tickets: ['# T-1\nstatus: in-progress\n'], grillCloseUI: '是（架構有得選）',
      frozen: {
        frozen: [], source: { projectId: 'p' },
        log: [{ path: 'a.tsx', action: 'unfreeze', at: '2026-01-01T00:00:00Z', reason: 'x', ticket: 'T-1' }],
      },
    });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /design 定稿哨兵/, '在途解凍不該被誤判成定稿沒落地');
  });

  test('frozen 是空陣列，log 的解凍已經回凍（unfreeze 後又 refreeze）→ 仍印，回凍完就不算在途', () => {
    const dir = makeProjectFixture({
      tickets: ['# T-1\nstatus: open\n'], grillCloseUI: '是（架構有得選）',
      frozen: { frozen: [], log: [
        { path: 'a.tsx', action: 'unfreeze', at: '2026-01-01T00:00:00Z', reason: 'x', ticket: 'T-1' },
        { path: 'a.tsx', action: 'refreeze', at: '2026-01-01T01:00:00Z', ticket: 'T-1' },
      ] },
    });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /frozen 是空陣列/, '已經回凍就不是在途狀態，空陣列仍要當問題點出來');
  });

  test('design-frozen.json 存在、frozen 非空且路徑都在 → 不印，即使 decisions/ 沒有任何 design-final 命名的檔案', () => {
    const dir = makeProjectFixture({ tickets: ['# T-1\nstatus: open\n'], grillCloseUI: '是（照既有架構做）' });
    writeFileSync(join(dir, 'real.txt'), 'x', 'utf8'); // 故意不建任何 design-final*.md，驗證不靠檔名
    writeFileSync(join(dir, '.constellation', 'design-frozen.json'),
      JSON.stringify({ frozen: ['real.txt'], source: { projectId: 'p' } }), 'utf8');
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /design 定稿哨兵/);
  });

  // 對抗複審 S7：source 欄檢查只讀 design-frozen.json、跟觸發條件（decisions 檔名或 tickets/
  // 有無票）無關，換觸發條件時被一併拿掉，但哨兵的處置文字仍要求寫 source 欄——說了要驗卻沒
  // 真的驗，補回這道獨立檢查。
  test('design-frozen.json 缺 source 欄，即使 frozen 非空且路徑都在 → 仍印，點名缺 source 欄', () => {
    const dir = makeProjectFixture({ tickets: ['# T-1\nstatus: open\n'], grillCloseUI: '是（照既有架構做）' });
    writeFileSync(join(dir, 'real.txt'), 'x', 'utf8');
    writeFileSync(join(dir, '.constellation', 'design-frozen.json'),
      JSON.stringify({ frozen: ['real.txt'] }), 'utf8'); // 故意不寫 source 欄
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /design 定稿哨兵/);
    assert.match(ctx, /缺 source 欄/);
  });
});

describe('session-start：決議 023 P11——MAP／CONTEXT 字數預算，必讀句改「約 N 萬字」', () => {
  test('MAP.md 超過約 4 萬字元預算 → 必讀句同句加註「已超出預算，下次 ship 先壓縮」並點名 MAP.md', () => {
    const dir = makeProjectFixture({ mapContent: '甲'.repeat(45000) });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /約 4\.5 萬字/);
    assert.match(ctx, /MAP\.md已超出預算，下次 ship 先壓縮/);
    assert.doesNotMatch(ctx, /全文\s*\d+\s*行/, '必讀句不該再用「全文 N 行」的舊措辭');
  });

  test('CONTEXT.md 超過約 1.5 萬字元預算 → 點名 CONTEXT.md，MAP 沒超就不點名 MAP', () => {
    const dir = makeProjectFixture({
      mapContent: '## 一、模組索引\n小小一份模組索引。',
      contextContent: '- **詞**：說明。\n'.repeat(2000),
    });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /CONTEXT\.md已超出預算/);
    assert.doesNotMatch(ctx, /MAP\.md已超出預算/);
  });

  test('兩檔都在預算內 → 不出現「已超出預算」', () => {
    const dir = makeProjectFixture({ mapContent: '## 一、模組索引\n小小一份。', contextContent: '- **詞**：小小一份。' });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /已超出預算/);
  });

  // 對抗複審 S6：不到一萬字元的小檔案原本一律顯示「約 0.0 萬字」，看起來像空檔；改成不到
  // 一萬字元時用「千字」為單位。
  test('小檔案（不到一萬字元）→ 顯示「約 N 千字」，不再是看起來像空檔的「約 0.0 萬字」', () => {
    const dir = makeProjectFixture({ mapContent: '甲'.repeat(3000) });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /約 3 千字/);
    assert.doesNotMatch(ctx, /萬字/, '不到一萬字元不該再用「萬字」單位');
  });
});

describe('session-start：決議 023 P20——決議與詞彙資訊只在置頂必讀句講一次，不再另立段落', () => {
  test('決議筆數只在必讀句出現一次，不再印獨立【決策記錄】段落', () => {
    const dir = makeProjectFixture({ decisionsCount: 3 });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /【決策記錄/);
    const hits = ctx.match(/共\s*3\s*筆/g) || [];
    assert.equal(hits.length, 1, '「共 3 筆」只該出現一次，不該在必讀句與獨立段落各講一次');
  });

  test('CONTEXT 詞條數併進必讀句、標籤只寫「專案詞彙」，不再印獨立【專案詞彙】段落', () => {
    const dir = makeProjectFixture({ contextContent: '- **詞一**：說明。\n- **詞二**：說明。\n' });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /【專案詞彙/);
    assert.doesNotMatch(ctx, /專案詞彙與業務規則/);
    assert.match(ctx, /CONTEXT\.md（專案詞彙，約[^）]*、2 個詞條）/);
  });
});
