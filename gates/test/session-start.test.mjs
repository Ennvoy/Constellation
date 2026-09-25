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

let nonProj, proj, gitCfgDir;

before(() => {
  gitCfgDir = mkdtempSync(join(tmpdir(), 'ss-gitcfg-'));
  const emptyGlobalConfig = join(gitCfgDir, 'gitconfig');
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
  for (const d of [nonProj, proj, gitCfgDir, ...extraDirs]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

function run(cwd) {
  const r = spawnSync(process.execPath, [GATE], { input: JSON.stringify({ cwd }), cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '' };
}

// 決議 023 P6／P11／P20 的黑箱夾具：依需要組出一個最小 Constellation 專案。
// tickets/decisions 若只用來測「存在幾個檔」，內文不必寫實——buildDesignSentinel／buildDecisionsSection
// 都只驗檔案存在性與計數，不解析內文（除了 grill-close.md 的「是否需要 UI」標記）。
// 但決議 024 D1／D4 附則的兩個哨兵會解析真實內文（大小流程欄位、盲點審收斂行、ship-report「做了
// 什麼」段、票內來源軸說明），對抗複審 S3 之後這些測試（grillCloseText／shipReport／帶內文的
// tickets）改用貼近真實專案的寫法（粗體、表格、標題式、分段），不能再隨便塞合成格式。
const extraDirs = [];
function makeProjectFixture({ tickets = [], nextRound = [], grillCloseUI = null, grillCloseText = null, decisionsCount = 0, mapContent = null, contextContent = null, frozen = null, shipReport = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ss-fx-'));
  extraDirs.push(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  mkdirSync(join(dir, '.constellation', 'tickets'), { recursive: true });
  mkdirSync(join(dir, '.constellation', 'decisions'), { recursive: true });
  tickets.forEach((content, i) => writeFileSync(join(dir, '.constellation', 'tickets', `T-${i}.md`), content, 'utf8'));
  if (nextRound.length) {
    mkdirSync(join(dir, '.constellation', 'next-round'), { recursive: true });
    nextRound.forEach((content, i) => writeFileSync(join(dir, '.constellation', 'next-round', `N-${i}.md`), content, 'utf8'));
  }
  if (grillCloseText != null) {
    // 完整覆寫 grill-close.md 內容（用於測「大小流程」欄位與盲點審收斂行的各種寫法）。
    writeFileSync(join(dir, '.constellation', 'decisions', 'grill-close.md'), grillCloseText, 'utf8');
  } else if (grillCloseUI) {
    writeFileSync(join(dir, '.constellation', 'decisions', 'grill-close.md'), `# grill-close\n是否需要 UI：${grillCloseUI}\n`, 'utf8');
  }
  for (let i = 1; i <= decisionsCount; i++) {
    writeFileSync(join(dir, '.constellation', 'decisions', `${String(i).padStart(3, '0')}-d.md`), `# ${i}\n背景：測試。\n`, 'utf8');
  }
  if (mapContent != null) writeFileSync(join(dir, '.constellation', 'MAP.md'), mapContent, 'utf8');
  if (contextContent != null) writeFileSync(join(dir, '.constellation', 'CONTEXT.md'), contextContent, 'utf8');
  if (frozen !== null) writeFileSync(join(dir, '.constellation', 'design-frozen.json'), JSON.stringify(frozen), 'utf8');
  if (shipReport != null) writeFileSync(join(dir, '.constellation', 'ship-report.md'), shipReport, 'utf8');
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

describe('session-start：決議 024 D1 附則——盲點審未收斂的機器提醒', () => {
  test('大小流程：大、檔尾無收斂行 → 印警示，措辭含舊規則例外的補行指引', () => {
    const dir = makeProjectFixture({ grillCloseText: '# grill-close\n大小流程：大、是否需要 UI：否\n' });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /盲點審尚未收斂/);
    assert.match(ctx, /決議 024|完整性四保險/); // 對齊 phase-grill.md 的處置指引
    assert.match(ctx, /舊規則/, '舊規則已記載跑完時應補行而非要求重跑，措辭要能看到這個例外');
    // 決議 028：時機規則改成「收斂前不進 design／weave」，換 session 一律改派新審查員看全集
    // （取代舊規則「需要 UI 時畫面製作可同時接續，5b 看圖拍板前才收斂」那套時機）。
    assert.match(ctx, /收斂前不進\s*design／weave/);
    assert.match(ctx, /換了 session 一律改派新審查員看全集/);
    assert.doesNotMatch(ctx, /畫面製作可同時接續/, '舊規則的時機措辭應已被取代');
  });

  test('半形冒號「大小流程:大」也要接受 → 印警示', () => {
    const dir = makeProjectFixture({ grillCloseText: '# grill-close\n大小流程:大\n是否需要 UI:否\n' });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /盲點審尚未收斂/);
  });

  test('檔尾已有「盲點審：已收斂（第 3 輪）」→ 不印', () => {
    const dir = makeProjectFixture({ grillCloseText: '# grill-close\n大小流程：大、是否需要 UI：否\n\n盲點審：已收斂（第 3 輪）\n' });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /盲點審尚未收斂/);
  });

  test('檔尾已有「盲點審：使用者喊停（第 5 輪）」→ 效力同收斂，不印', () => {
    const dir = makeProjectFixture({ grillCloseText: '# grill-close\n大小流程：大、是否需要 UI：否\n\n盲點審：使用者喊停（第 5 輪）\n' });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /盲點審尚未收斂/);
  });

  test('大小流程：小 → 小流程可省略本保險，不印', () => {
    const dir = makeProjectFixture({ grillCloseText: '# grill-close\n大小流程：小、是否需要 UI：否\n' });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /盲點審尚未收斂/);
  });

  // 已知有專案把備註寫進括號（原評為大流程、後改小流程），若只比對字串含不含「大流程」
  // 三字會誤判——要解析欄位真正的值，不能只看整段含不含那三個字。
  test('大小流程寫成「小（該功能原評為大流程，後來降為小流程）」→ 解析出欄位值是小，不印', () => {
    const dir = makeProjectFixture({ grillCloseText: '# grill-close\n大小流程：小（該功能原評為大流程，後來降為小流程）、是否需要 UI：否\n' });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /盲點審尚未收斂/, '欄位值其實是小，不該被括號裡的備註誤判成大流程');
  });

  test('grill-close.md 不存在 → 訪談根本沒收尾，不印盲點審警示（交給另一條矛盾提示）', () => {
    const dir = makeProjectFixture({});
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /盲點審尚未收斂/);
  });

  // 對抗複審 M1：真實專案的寫法遠比合成的純文字「大小流程：大」多——粗體欄位名、單列表格、
  // 標題式（值在下一行）都要認得出來，收斂行同理可能被加粗。
  test('真實寫法：欄位名加粗「- **大小流程**：大」→ 仍要印警示', () => {
    const dir = makeProjectFixture({ grillCloseText: '# grill-close\n- **大小流程**：大\n- 是否需要 UI：否\n' });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /盲點審尚未收斂/);
  });

  test('真實寫法：單列 key-value 表格「| **大小流程** | **大** |」→ 仍要印警示', () => {
    const dir = makeProjectFixture({ grillCloseText: '# grill-close\n| **大小流程** | **大** |\n| 是否需要 UI | 否 |\n' });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /盲點審尚未收斂/);
  });

  test('真實寫法：欄位名與值都加粗「- **大小流程**：**大**」→ 仍要印警示', () => {
    const dir = makeProjectFixture({ grillCloseText: '# grill-close\n- **大小流程**：**大**\n' });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /盲點審尚未收斂/);
  });

  test('真實寫法：標題式「## 1. 大小流程」獨占一行、值寫在下一行 → 仍要印警示', () => {
    const dir = makeProjectFixture({ grillCloseText: '# grill-close\n## 1. 大小流程\n大流程，本次規模較大。\n' });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /盲點審尚未收斂/);
  });

  test('收斂行加粗「- **盲點審**：已收斂（第 3 輪）」→ 仍要辨識出已收斂，不印', () => {
    const dir = makeProjectFixture({ grillCloseText: '# grill-close\n大小流程：大\n\n- **盲點審**：已收斂（第 3 輪）\n' });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /盲點審尚未收斂/, '加粗不該讓已收斂的判斷失效而誤報');
  });

  // 對抗複審 M2：SKILL.md Step 0 這條保險只在「tickets/ 還沒有票」的分支下才適用。
  test('tickets/ 已有票（已過 weave）→ 即使大流程無收斂行也不印，避免每次開場誤報', () => {
    const dir = makeProjectFixture({
      tickets: ['# T-1\nstatus: in-progress\n'],
      grillCloseText: '# grill-close\n大小流程：大、是否需要 UI：否\n',
    });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /盲點審尚未收斂/, '已經開了票代表這一輪的盲點審早就收斂過，不該對舊 grill-close 天天誤報');
  });
});

describe('session-start：決議 024 D4 附則——有票卻沒有訪談收尾的矛盾提示', () => {
  test('tickets/ 有票、無 grill-close.md、無出貨報告、票也不是承接票 → 印現況矛盾', () => {
    const dir = makeProjectFixture({ tickets: ['# T-1\nstatus: open\n\n## 目標\n做某個一般功能。\n'] });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /現況矛盾/);
    assert.match(ctx, /決議 024/);
  });

  test('tickets/ 有票、grill-close.md 存在 → 訪談有收尾，不矛盾，不印', () => {
    const dir = makeProjectFixture({ tickets: ['# T-1\nstatus: open\n'], grillCloseUI: '否' });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /現況矛盾/);
  });

  test('tickets/ 沒有任何票 → 沒東西可矛盾，不印', () => {
    const dir = makeProjectFixture({});
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /現況矛盾/);
  });

  test('例外一：出貨歸檔做到一半——ship-report.md「做了什麼」第一行涵蓋現行全部票 → 不印', () => {
    const dir = makeProjectFixture({
      tickets: ['# T-1\nstatus: done\n', '# T-2\nstatus: done\n'], // 檔名 T-0.md、T-1.md
      shipReport: '# 出貨報告\n\n## 做了什麼\nT-0、T-1 都已完成，修好了 XXX。\n\n## 驗了什麼\n全量通過。\n',
    });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /現況矛盾/);
  });

  test('ship-report.md 存在但沒涵蓋現行全部票（只列了一張）→ 仍印現況矛盾', () => {
    const dir = makeProjectFixture({
      tickets: ['# T-1\nstatus: done\n', '# T-2\nstatus: open\n'], // 檔名 T-0.md、T-1.md
      shipReport: '# 出貨報告\n\n## 做了什麼\nT-0 已完成 XXX。\n',
    });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /現況矛盾/, 'ship-report 沒涵蓋全部票，不算歸檔做到一半');
  });

  test('票裡只有部分標了來源軸、其餘沒有 → 不算「只剩承接票」，仍印現況矛盾', () => {
    const dir = makeProjectFixture({
      tickets: [
        '# T-1\nstatus: open\n\n## 目標\n來源軸：Standards，修正 XXX。\n',
        '# T-2\nstatus: open\n\n## 目標\n做別的一般功能，不是承接票。\n',
      ],
    });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /現況矛盾/);
  });

  // 對抗複審 S1：票號比對原本用 .includes() 子字串，T-1 會被 T-10 撞號誤判成已涵蓋。
  test('票號比對邊界安全：ship-report 只提到 T-10，T-1 不該被撞號誤判成已涵蓋', () => {
    const dir = makeProjectFixture({ shipReport: '# 出貨報告\n\n## 做了什麼\nT-10 已完成，修好了 XXX。\n' });
    writeFileSync(join(dir, '.constellation', 'tickets', 'T-1.md'), '# T-1\nstatus: open\n\n## 目標\n做別的功能。\n', 'utf8');
    writeFileSync(join(dir, '.constellation', 'tickets', 'T-10.md'), '# T-10\nstatus: done\n', 'utf8');
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /現況矛盾/, 'T-1 沒被提到，不該被 T-10 的字串撞號誤判成已涵蓋');
  });

  // 對抗複審 M3：真實 ship-report 的「做了什麼」段常見表格與範圍寫法，只看第一行的舊實作會漏掉。
  test('例外一：ship-report 用表格列出票號（不在第一行）→ 全部涵蓋時不印', () => {
    const dir = makeProjectFixture({
      tickets: ['# T-1\nstatus: done\n', '# T-2\nstatus: done\n'], // 檔名 T-0.md、T-1.md
      shipReport: '# 出貨報告\n\n## 做了什麼\n| 票 | 一句話 |\n|---|---|\n| T-0 | 做了 A |\n| T-1 | 做了 B |\n\n## 驗了什麼\n全量通過。\n',
    });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /現況矛盾/, '表格列出的票號在做了什麼段內，只看第一行的舊實作會漏掉');
  });

  test('例外一：ship-report 用範圍寫法「T-0~T-1」→ 展開範圍後全部涵蓋，不印', () => {
    const dir = makeProjectFixture({
      tickets: ['# T-1\nstatus: done\n', '# T-2\nstatus: done\n'], // 檔名 T-0.md、T-1.md
      shipReport: '# 出貨報告\n\n## 做了什麼\n本輪出貨 2 張票（T-0~T-1），修好了 XXX。\n',
    });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /現況矛盾/);
  });

  // 承接票不再有「來源軸」內容例外——下一輪要做的事一律開進 .constellation/next-round/，
  // 這裡放的票就算寫著來源軸說明，只要放錯在 tickets/ 一樣算矛盾，訊息要指路正確的落點。
  test('一張已出貨、一張承接票放錯在 tickets/ → 印現況矛盾，訊息含 next-round', () => {
    const dir = makeProjectFixture({
      tickets: [
        '# T-1\nstatus: done\n', // 檔名 T-0.md：靠出貨報告涵蓋
        '# T-2\nstatus: open\n\n## 目標\n來源軸：Standards，修正 XXX。\n', // 檔名 T-1.md：承接票放錯位置
      ],
      shipReport: '# 出貨報告\n\n## 做了什麼\nT-0 已完成 XXX。\n',
    });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /現況矛盾/, '承接票放錯在 tickets/ 不再是例外，出貨那張仍靠例外各自判斷，不會蓋過這張');
    assert.match(ctx, /next-round/, '訊息要指路承接票該放的位置');
  });
});

describe('session-start：使用者已拍板的「下輪待辦」抽屜——next-round/ 只報張數，不當成本輪現況', () => {
  // E4 回歸網：下一輪的承接票放進 next-round/、tickets/ 本輪是空的時，票況要照空專案處理
  // （0 張＋附抽屜張數），盲點審提醒照常看 grill-close.md 本身，design 哨兵與現況矛盾兩個
  // 哨兵都只認 tickets/ 有沒有票，next-round/ 不該讓它們誤觸發或誤壓下。
  test('next-round/ 有票、tickets/ 空、grill-close 大流程需要 UI 且沒有收斂行 → 票況 0 張並附待辦張數、印盲點審提醒、不印 design 哨兵、不印矛盾', () => {
    const dir = makeProjectFixture({
      nextRound: ['# T-9\nstatus: open\n\n## 目標\n來源軸：Standards，修正 XXX。\n'],
      grillCloseText: '# grill-close\n大小流程：大、是否需要 UI：是（照既有架構做）\n',
    });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /共 0 張票/, 'next-round/ 不算本輪的票，tickets/ 是空的，票況該印 0 張');
    assert.match(ctx, /下輪待辦 1 張在 \.constellation\/next-round\//, '待辦抽屜張數要附在票況那一行');
    assert.match(ctx, /盲點審尚未收斂/, '大流程沒有收斂行，盲點審提醒仍要出現');
    assert.doesNotMatch(ctx, /design 定稿哨兵/, 'tickets/ 是空的（還沒過 weave），design 哨兵不該印');
    assert.doesNotMatch(ctx, /現況矛盾/, 'tickets/ 是空的，沒有票可矛盾');
  });

  test('next-round/ 沒有票（或不存在）→ 票況不附待辦張數', () => {
    const dir = makeProjectFixture({});
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /下輪待辦/);
  });

  // 對抗審查 should-fix：grill-close.md 不存在時（訪談收尾還沒問過那一題），維持舊句「訪談收尾時
  // 問使用者…」；grill-close.md 已存在時（那一題本輪已經問過、答案記在檔尾），改指向那一行，不要
  // 讓代理人誤以為「還沒問」而重複詢問使用者。
  test('next-round/ 有票、沒有 grill-close.md → 票況維持「訪談收尾時問使用者」舊句', () => {
    const dir = makeProjectFixture({ nextRound: ['# T-9\nstatus: open\n\n## 目標\n來源軸：Standards。\n'] });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /下輪待辦 1 張在 \.constellation\/next-round\/（訪談收尾時問使用者要順便做、留著還是丟掉，不是現在要做的事）/);
  });

  test('next-round/ 有票、grill-close.md 已存在（本輪已問過那一題）→ 票況改指向 grill-close.md 檔尾那一行', () => {
    const dir = makeProjectFixture({
      nextRound: ['# T-9\nstatus: open\n\n## 目標\n來源軸：Standards。\n'],
      grillCloseText: '# grill-close\n大小流程：小、是否需要 UI：否\n下輪待辦：放棄 T-9\n',
    });
    const ctx = JSON.parse(run(dir).stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /下輪待辦 1 張在 \.constellation\/next-round\/（本輪併入哪幾張見 decisions\/grill-close\.md 檔尾「下輪待辦」那一行）/);
    assert.doesNotMatch(ctx, /訪談收尾時問使用者要順便做/, '這一題本輪已經問過，不該再印成還沒問');
  });
});
