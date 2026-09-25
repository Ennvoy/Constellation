#!/usr/bin/env node
// gates/kill-guard.mjs — 殺行程守門（PreToolUse on Bash|PowerShell）。
// 判定是 killGuardCheck(input) → { block, message }，由 gates/pre-tool-use.mjs 動態載入呼叫
// （寫法比照 gates/git-guardrail.mjs：純函式、PASS/BLOCK 常數、fail-open）。
//
// 依 DESIGN.md §5、決議 026：擋下「殺掉別人 machine 鎖持有方的 PID」，以及「別人持有鎖時，
// 按名稱整批殺／目標不是寫死數字的殺法（管線送進去、變數代入）」。理由：訊息攔不住人——09-25
// 第二次誤殺是子代理明知故犯，不是認錯行程——只有機械擋得住；判不準時寧可多擋一次，不可放過
// 真的殺到持有方（與 gates/git-guardrail.mjs 的誤攔權衡同一立場）。
//
// 判定邏輯（對抗審查 wave5 修正版）：**反過來想**——別人持有鎖時，只要指令裡出現殺行程動詞
// （taskkill／Stop-Process／spps／裸 kill／wmic ... delete／CIM Terminate／.Kill() 方法呼叫），
// 就要求那個敘述的目標**全部**是寫死的數字 PID，否則一律擋（含位置參數、`-Id:`、`@(...)`、變數、
// command substitution、`/FI` 篩選式等看不出目標的寫法——凡是抓不到寫死數字，一律當成看不出安全）；
// 按名稱整批殺（`/IM`、`-Name`／`-ProcessName`／`-n`）、`wmic ... delete`、CIM Terminate、`.Kill()`
// 方法呼叫則不論有沒有數字，一律當成不安全。指令先拆成「敘述」（依管線、`;`／`&&`／`||`／換行切，
// 並把 `{ }` 區塊本文一併當額外敘述檢查，涵蓋 `ForEach-Object { Stop-Process ... }` 這種寫法）逐條判斷，
// 只有某條敘述真的在呼叫殺行程動詞才檢查它——單純把殺行程字樣當**字串**傳給 `grep`／`findstr`／
// `Select-String` 的唯讀查詢管線不會被誤擋（敘述的開頭詞不是殺行程動詞就不算）。
//
// 不做「PID 存活判定＝擋不擋」以外的事：讀到持有者後先確認 pid 是否還活著——已死的登記檔不该
// 再擋人（常見於 runner 被 TaskStop／關視窗／`taskkill /F`／重開機後留下的殘檔，沒有人會再跑
// ship 去自然清掉它），順手呼叫 `invalidate` 把它改名作廢（只改名不殺，符合決議 020），然後放行。
// 孫行程 PID 不在保護範圍內、Codex 的 matcher 看不看得到 exec 內層指令待實測——這兩點已在
// DESIGN.md §11.5 揭露，本檔不另外補強（第二版再處理）。
import { readHolder, isPidAlive, invalidate } from './lease.mjs';

const PASS = { block: false };
const BLOCK = msg => ({ block: true, message: msg });

// 敘述開頭詞是不是殺行程動詞：把字串開頭可能的變數指派、括號剝掉後看第一個詞。
const KILL_LEADER_RE = /^(?:taskkill|stop-process|spps|kill)\b/i;

// 拆成一條條「敘述」：先按管線（單一 `|`，不含 `||`）切，各段再按 `;`／`&&`／`||`／換行切；
// 每段若含 `{ ... }` 區塊（ForEach-Object／foreach 的迴圈本體），區塊本文另外當一條敘述加進來
// 一併判斷——只拆一層，不做完整的殼語法剖析，足夠涵蓋審查列出的寫法即可（極簡原則）。
function splitStatements(cmd) {
  const stmts = [];
  const pipeSegs = cmd.split(/(?<!\|)\|(?!\|)/);
  for (const seg of pipeSegs) {
    for (const part of seg.split(/;|&&|\|\||\r?\n/)) {
      stmts.push(part);
      for (const m of part.matchAll(/\{([^{}]*)\}/g)) {
        for (const inner of m[1].split(/;|&&|\|\||\r?\n/)) stmts.push(inner);
      }
    }
  }
  return stmts;
}

// 這條敘述是不是在呼叫殺行程動詞：裸動詞開頭、或 wmic...delete、或 CIM Terminate、或 .Kill() 方法呼叫
// ——後三者不是「開頭詞」形狀，跨管線／巢狀出現時也算數（例：`Get-CimInstance ... | Invoke-CimMethod
// -MethodName Terminate`、`(Get-Process -Id N).Kill()`）。
function isKillStatement(stmt) {
  const leader = stmt.trim().replace(/^\(+/, '');
  if (KILL_LEADER_RE.test(leader)) return true;
  if (/^wmic\b/i.test(leader) && /\bdelete\b/i.test(stmt)) return true;
  if (/-methodname\s+terminate\b/i.test(stmt)) return true;
  if (/\.kill\(\)/i.test(stmt)) return true;
  return false;
}

// 一律視為不安全、不論有沒有寫死數字：按名稱整批殺（`/IM`、`-Name`／`-ProcessName`／`-n`）、
// `wmic ... delete`、CIM Terminate、`.Kill()` 方法呼叫。
function isAlwaysUnsafe(stmt) {
  if (/\/{1,2}im\b/i.test(stmt)) return true;
  if (/-(?:process)?name\b/i.test(stmt)) return true;
  if (/(?<![\w-])-n\b/i.test(stmt)) return true;
  if (/^\s*wmic\b/i.test(stmt) && /\bdelete\b/i.test(stmt)) return true;
  if (/-methodname\s+terminate\b/i.test(stmt)) return true;
  if (/\.kill\(\)/i.test(stmt)) return true;
  return false;
}

// 從一條敘述裡挖出**寫死的數字** PID：
//   taskkill /PID、Git Bash 的 //PID（可重複＝一次多個）
//   PowerShell -Id（含 `-Id:`、`-Id @(N)`、逗號分隔多個；用 lookbehind 排除 `--id` 長旗標誤命中）
//   Stop-Process／spps 的位置參數（第一個引數直接是數字，如 `Stop-Process 1234 -Force`）
//   裸 kill（POSIX，可帶訊號旗標，如 `kill -9 1234`）
// 抓不到任何寫死數字就回空集合——呼叫端把「看不出目標」一律當成不安全（變數、command substitution、
// `/FI` 篩選式等都會落在這裡，不必逐一列舉辨識，天然被擋）。
function literalPids(stmt) {
  const pids = new Set();
  for (const m of stmt.matchAll(/\/{1,2}pid\s+(\d+)/gi)) pids.add(Number(m[1]));
  for (const m of stmt.matchAll(/(?<!-)-id\b[:\s]*@?\(?\s*(\d[\d,\s]*)\)?/gi)) {
    for (const n of m[1].split(/[,\s]+/)) if (n) pids.add(Number(n));
  }
  const pos = stmt.trim().match(/^(?:stop-process|spps)\s+(\d+(?:\s*,\s*\d+)*)\b/i);
  if (pos) for (const n of pos[1].split(/[,\s]+/)) if (n) pids.add(Number(n));
  for (const m of stmt.matchAll(/\bkill\b\s+(?:-\S+\s+)*((?:\d+\s*)+)/gi)) {
    for (const n of m[1].trim().split(/\s+/)) pids.add(Number(n));
  }
  return pids;
}

const projectName = p => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '未知專案';
function startedHHMM(ts) {
  const d = new Date(Number(ts));
  if (!Number.isFinite(d.getTime())) return '不明時間';
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function killGuardCheck(input) {
  try {
    const ti = input.tool_input ?? input.toolInput ?? {};
    const cmd = String(ti.command ?? '');
    // 快速判斷：完全不含任何殺行程字樣的指令直接放行，不必往下讀登記檔。
    if (!/taskkill|stop-process|spps|\bkill\b|wmic|\.kill\(|\bterminate\b/i.test(cmd)) return PASS;

    const holder = readHolder();
    if (!holder) return PASS; // 沒人持有 machine 鎖

    // 持有者已死：殘留的登記檔不該一直誤擋（runner 被 TaskStop、關視窗、`taskkill /F`、重開機
    // 都會留下這種殘檔，且沒有人會再跑 ship 去自然清掉它）。順手作廢，只改名不殺（決議 020）。
    if (!isPidAlive(holder.pid)) {
      try { invalidate(holder); } catch {}
      return PASS;
    }

    // 同一 session 放行：自己收自己的行程不歸這道守門管（決議 020 的老規矩）。
    // session id 兩個來源都認：hook stdin 的 payload（兩種鍵名）與 runtime 注入的環境變數
    // （與 verify-runner.mjs 的 acquireShipLease 寫入 holder.session 用同一組來源與優先序：
    // Codex 從 Claude Code 內被啟動時會繼承 CLAUDE_CODE_SESSION_ID，CODEX_SESSION_ID 優先採用）。
    const self = String(
      input.session_id || input.sessionId ||
      process.env.CODEX_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || ''
    );
    if (self && holder.session && self === holder.session) return PASS;

    const guarded = new Set([holder.pid, holder.shellPid].filter(Boolean).map(Number));
    const blockMsg = () => BLOCK(
      `這是 ${projectName(holder.root)} 的出貨全量（起於 ${startedHHMM(holder.grantedAt || holder.startedAt)}），` +
      '不是你的；要停請用 SendMessage 問對方。'
    );

    for (const stmt of splitStatements(cmd)) {
      if (!isKillStatement(stmt)) continue;
      if (isAlwaysUnsafe(stmt)) return blockMsg();
      const pids = literalPids(stmt);
      if (pids.size === 0) return blockMsg(); // 目標看不出是寫死數字，一律當成不安全
      for (const p of pids) if (guarded.has(p)) return blockMsg();
    }
    return PASS;
  } catch {
    return PASS; // 守門自己出錯 fail-open，不擋事
  }
}
