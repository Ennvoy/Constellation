#!/usr/bin/env node
// gates/pre-tool-use.mjs — Bash|PowerShell 三道閘門的單進程 dispatcher。
//
// 起因（實測）：Windows 上同時開十幾個 runtime session 時，機器常駐 30+ 個 node 進程，node 冷啟動
// 從 1 秒被拉到數秒；而 runtime 給每支 hook 的秒數預算是固定的，Bash|PowerShell 這組掛兩支各起一個
// node，等於吃兩份啟動成本——實測 8 支併發共需 28 秒，遠超預算，噴 hook timeout。hook 是 fail-open，
// 超時不擋事，但每次工具呼叫都白等滿預算，體感就是 runtime 整個變慢。
//
// 合併只換載體、不動職責：git 守門、commit 守門分別是 DESIGN.md §5 的閘門 1、2；殺行程守門
// （見 gates/kill-guard.mjs）是決議 026 新增的硬性擋下，不在編號閘門之列（DESIGN.md §5 末段）。
// 三者判定邏輯原封沿用各自檔案 export 的純函式。指令字串不含 git 字樣、也不含殺行程字樣（taskkill／
// Stop-Process／spps／裸 kill／wmic／`.kill(`／terminate，字邊界比對避免命中 skills 路徑誤載模組）
// 就直接放行結束，三道閘門連同各自用到的模組都不載入——取值方式與三道閘門判定條件完全一致（皆兼容
// tool_input／toolInput），是安全超集：三道閘門要判定任何東西，命令字串本來就一定含對應字樣。
// 注意：這只是「要不要載入 kill-guard.mjs」的粗篩，不要求後面一定接數字——`| kill`、`kill -n` 這種
// 沒有緊跟數字的寫法也要能觸發載入，真正的安全判斷交給 kill-guard.mjs 自己逐敘述分析。
const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const NEEDS_GATE_RE = /git|taskkill|stop-process|spps|\bkill\b|wmic|\.kill\(|\bterminate\b/i;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => process.exit(0));
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', async () => {
  let input;
  try { input = JSON.parse(stripBom(raw).trim() || '{}'); } catch { return process.exit(0); }
  const ti = input.tool_input ?? input.toolInput ?? {};
  if (!NEEDS_GATE_RE.test(String(ti.command ?? ''))) return process.exit(0);

  // 依序判、任一道 block 即擋下並回該道原本的訊息（訊息不改寫，使用者看到的與合併前一字不差）。
  // 逐道各自動態 import＋try-catch fail-open：一道爆掉或載入失敗都不影響另一道。
  const loaders = [
    async () => (await import('./git-guardrail.mjs')).gitGuardrailCheck,
    async () => (await import('./commit-gate.mjs')).commitGateCheck,
    async () => (await import('./kill-guard.mjs')).killGuardCheck,
  ];
  for (const load of loaders) {
    let r;
    try { r = (await load())(input); } catch { r = null; }
    if (r && r.block) { process.stderr.write(String(r.message || '') + '\n'); process.exit(2); }
  }
  process.exit(0);
});
