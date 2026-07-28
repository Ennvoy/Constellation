#!/usr/bin/env node
// gates/precommit-install.mjs — 冪等安裝 Constellation 的 git 原生 pre-commit 兜底。
// 由 gates/session-start.mjs 自動呼叫（每次開 session、冪等），把一段 sh 區塊寫進 repo 的
// .git/hooks/pre-commit，內容是呼叫 `node gates/commit-gate.mjs --precommit`。
//
// 為什麼需要它：commit-gate.mjs 掛在 PreToolUse，只攔得到「Claude Code 跑的 git commit」。
// 使用者自己在終端機打 git commit、或子行程／npm script／release 腳本／MCP run_code 發起的 commit
// 全都繞過那層。git 原生 pre-commit 是唯一能兜住這整批繞法的位置。
// （Flow 時代這層由 flow-precommit.mjs + precommit-install.mjs 提供；Constellation 首次搬遷時
// 刻意未搬，2026-07-28 Flow 退役後缺口曝光，經使用者拍板補上。判定邏輯不另立門戶，
// 一律回頭呼叫 commit-gate.mjs 本尊，確保兩條呼叫路徑永遠同一套規則、不會漂移。）
//
// 紀律：
//   ① 只裝標準 .git/hooks（core.hooksPath 空時）；被 husky/lefthook 改向 → 醒目回報「兜底沒裝進」
//      而非靜默裝進一個不會執行的地方（比沒裝更糟的假安全感）。
//   ② 既有 pre-commit 用 marker 區塊 append、絕不 clobber；非 sh 直譯器的 hook 不碰。
//   ③ 全程 fail-silent／不 throw：安裝失敗回 warn，永不影響 session 開場或 commit。
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // gates/ 目錄（commit-gate.mjs 同層）
const BEGIN = '# >>> constellation-gate (managed by Constellation) >>>';
const END = '# <<< constellation-gate <<<';
const BLOCK_RE = /# >>> constellation-gate \(managed by Constellation\) >>>[\s\S]*?# <<< constellation-gate <<<\n?/;
// Flow 退役殘留：舊 repo 的 pre-commit 可能還留著 flow-gate 死區塊（指向已刪的 flow-precommit.mjs，
// 靠 `[ -f ]` 守衛 no-op 不會炸，但留著只會混淆）。安裝時順手清掉，不另外做一支清理工具。
const LEGACY_FLOW_BLOCK_RE = /# >>> flow-gate \(managed by flow-toolkit\) >>>[\s\S]*?# <<< flow-gate <<<\n?/;

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
  } catch {
    return '';
  }
}

function safeRead(p) {
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}

// 回 { installed, alreadyInstalled, skipped, warn, path }。呼叫端據 installed（首裝）告知、據 warn 提醒。
export function installPrecommit(cwd) {
  const gitDir = git(cwd, ['rev-parse', '--git-dir']);
  if (!gitDir) return { skipped: 'not-git' }; // 非 git repo → 不裝

  const scriptPosix = join(here, 'commit-gate.mjs').replace(/\\/g, '/'); // sh 用正斜線（Windows 路徑也轉）
  // 兩道守衛都是關鍵 robustness（fail-open：結構性缺失一律不擋 commit）：
  //   ① `[ -f <script> ]`：Constellation 被移走/改路徑後自動 no-op（否則 `node <不存在路徑>` exit 非 0＝brick 該 repo 所有 commit）。
  //   ② `command -v node`：node 不在 hook 的 sh PATH（GUI git／CI 常缺）→ 整段跳過（否則 exit 127＝brick）。
  const block = [
    BEGIN,
    `if [ -f "${scriptPosix}" ] && command -v node >/dev/null 2>&1; then node "${scriptPosix}" --precommit || exit $?; fi`,
    END,
  ].join('\n');

  // core.hooksPath 被 husky/lefthook 改向 → 不硬裝（避免與其管理機制打架／裝進不會執行的 wrapper）。
  const hooksPath = git(cwd, ['config', '--get', 'core.hooksPath']);
  if (hooksPath) {
    return {
      skipped: 'custom-hookspath',
      warn: `偵測到自訂 git hook 路徑（core.hooksPath=${hooksPath}，多半是 husky/lefthook）——Constellation 沒自動裝 pre-commit 兜底以免打架。要兜底：把「node "${scriptPosix}" --precommit」加進你的 pre-commit。`,
    };
  }

  // worktree 下 --git-dir 指向 .git/worktrees/<name>，其 hooks/ 不是 commit 實際會執行的位置；
  // --git-common-dir 指向共用主 .git（hooks 真正所在）。非 worktree 兩者相同。
  const commonDir = git(cwd, ['rev-parse', '--git-common-dir']) || gitDir;
  const hooksDir = isAbsolute(commonDir) ? join(commonDir, 'hooks') : join(cwd, commonDir, 'hooks');
  const target = join(hooksDir, 'pre-commit');
  const cur = existsSync(target) ? safeRead(target) : '';
  const firstTime = !BLOCK_RE.test(cur);

  // 先清 Flow 死區塊（若有），再處理自家區塊——順序固定，避免清除影響自家區塊的比對。
  const curCleaned = cur.replace(LEGACY_FLOW_BLOCK_RE, '');

  let next;
  if (BLOCK_RE.test(curCleaned)) {
    next = curCleaned.replace(BLOCK_RE, block + '\n'); // 更新（路徑可能變；自家區塊安全 replace）
  } else if (curCleaned.trim()) {
    // 既有 pre-commit → append，不 clobber。但先看 shebang：非 POSIX shell 直譯器（python/ruby/perl/node
    // 手寫 hook）append sh 區塊會讓整檔被該直譯器當語法錯 → brick commit。偵測到非 sh 就別 append。
    const shebang = (curCleaned.match(/^#!.*$/m) || [''])[0];
    if (shebang && !/\b(sh|bash|dash|zsh|ksh)\b/.test(shebang)) {
      return {
        skipped: 'foreign-interpreter',
        warn: `既有 pre-commit 是非 sh 直譯器（${shebang.trim()}）——Constellation 沒自動 append 以免破壞你的 hook。要兜底：手動把「node "${scriptPosix}" --precommit」接進去。`,
      };
    }
    next = (curCleaned.endsWith('\n') ? curCleaned : curCleaned + '\n') + block + '\n';
  } else {
    next = '#!/bin/sh\n' + block + '\n'; // 全新（含「原本只剩 Flow 死區塊、清掉後變空」這種情況）
  }

  if (next === cur) return { alreadyInstalled: true, path: target }; // 冪等：已裝且無變動

  try {
    if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
    writeFileSync(target, next, 'utf8');
    try { chmodSync(target, 0o755); } catch { /* Windows no-op／權限問題不致命 */ }
    return firstTime ? { installed: true, path: target } : { alreadyInstalled: true, path: target };
  } catch (e) {
    return { warn: `pre-commit 兜底寫入失敗（${target}）：${e.message}` };
  }
}
