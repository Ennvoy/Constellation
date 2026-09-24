#!/usr/bin/env node
// gates/install-hooks.mjs — install.ps1 呼叫的小工具：合併／拆除 hooks 設定。
// 原本內嵌在 install.ps1 字串裡（執行期寫成暫存 .cjs 檔跑完即刪），抽成真檔案的原因：內嵌字串
// 不會被 gates/*.mjs 的逐支語法檢查覆蓋到，也沒辦法單獨測試。抽出來之後它自己也在檢查清單裡。
//
// 用法：
//   node install-hooks.mjs merge-hooks <targetPath> <fragmentPath> merge|uninstall <rootPath>
//   node install-hooks.mjs worktree-baseref <targetPath> merge|uninstall
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const stripBOM = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

function readJson(filePath, fallback) {
  if (!filePath || filePath === 'NONE' || !existsSync(filePath)) return fallback;
  const trimmed = stripBOM(readFileSync(filePath, 'utf8')).trim();
  return trimmed === '' ? fallback : JSON.parse(trimmed);
}

const isPlainObject = v => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// merge-hooks：合併／拆除 ~/.claude/settings.json、~/.codex/hooks.json 的 hooks 設定
// ---------------------------------------------------------------------------

// 自家 hook 腳本的六支已知名字（不含 clean-artifacts／precommit-install／verify-runner，
// 那三支不掛在 hooks 設定裡）；之後新增或改名腳本要記得同步這張表。
const GATE_SCRIPT_NAMES = ['session-start', 'serve', 'close-gate', 'pre-tool-use', 'commit-gate', 'git-guardrail'];
const GATE_SCRIPT_RE = new RegExp(`[\\\\/]gates[\\\\/](${GATE_SCRIPT_NAMES.join('|')})\\.mjs`);

// 指令字串形狀比對：不管 repo 裝在哪個路徑，只要是 node "...\gates\<六支之一>.mjs" 這個形狀
// 就認得出來——repo 搬家後，舊路徑的舊登記一樣認得出來，不像比對「目前 root 路徑」那樣搬家就失效。
function looksLikeGateScript(value) {
  if (typeof value === 'string') return GATE_SCRIPT_RE.test(value);
  if (Array.isArray(value)) return value.some(looksLikeGateScript);
  if (isPlainObject(value)) return Object.values(value).some(looksLikeGateScript);
  return false;
}

// root 路徑子字串比對：涵蓋不符合上面六支腳本形狀、但仍屬於本專案 gates/ 底下的其他自家指令
// （正反斜線都認）。與指令形狀比對雙條件擇一，任一成立即視為自家項。
function makeContainsMarker(rootPath) {
  const marker1 = rootPath + '\\gates';
  const marker2 = rootPath.split('\\').join('/') + '/gates';
  return function containsMarker(value) {
    if (typeof value === 'string') return value.includes(marker1) || value.includes(marker2);
    if (Array.isArray(value)) return value.some(containsMarker);
    if (isPlainObject(value)) return Object.values(value).some(containsMarker);
    return false;
  };
}

// 自家項判斷：不看 _constellation 旗標——它打在內層 hook 物件（hooks[].command 那一層），
// 而被逐一檢查的 entry 是外層 matcher 群組（{ matcher, hooks: [...] } 或 { hooks: [...] }），
// 兩層對不上，旗標永遠比對不到、從未真正發揮作用。
function isOwnEntry(entry, containsMarker) {
  return looksLikeGateScript(entry) || containsMarker(entry);
}

// 合併／拆除 hooks 設定。統一路徑：先把「所有既有事件」（含 fragment 這次已經不再提到、
// 但舊登記還留著的事件，例如被撤掉的 SessionEnd）裡的自家項全部拔掉，再把 fragment 的內容
// 附加回對應事件——同一條路徑處理安裝、repo 搬家重裝、撤事件三種情境。
// mode=uninstall 做到「拔掉」這一步就結束，不附加。
export function mergeHooks(targetPath, fragmentPath, mode, rootPath) {
  let target = readJson(targetPath, {});
  if (!isPlainObject(target)) target = {};
  if (!isPlainObject(target.hooks)) target.hooks = {};
  const hooksRoot = target.hooks;
  const containsMarker = makeContainsMarker(rootPath);

  let ownCount = 0;
  let removedCount = 0;

  for (const eventKey of Object.keys(hooksRoot)) {
    const arr = Array.isArray(hooksRoot[eventKey]) ? hooksRoot[eventKey] : [];
    const kept = [];
    for (const entry of arr) {
      if (isOwnEntry(entry, containsMarker)) {
        removedCount++;
      } else {
        kept.push(entry);
      }
    }
    if (kept.length === 0) delete hooksRoot[eventKey];
    else hooksRoot[eventKey] = kept;
  }

  if (mode !== 'uninstall') {
    const fragmentRaw = readJson(fragmentPath, {});
    const fragmentHooks = isPlainObject(fragmentRaw) && isPlainObject(fragmentRaw.hooks) ? fragmentRaw.hooks : fragmentRaw;
    const fh = isPlainObject(fragmentHooks) ? fragmentHooks : {};
    for (const eventKey of Object.keys(fh)) {
      const fragArr = Array.isArray(fh[eventKey]) ? fh[eventKey] : [];
      const existingArr = Array.isArray(hooksRoot[eventKey]) ? hooksRoot[eventKey] : [];
      hooksRoot[eventKey] = existingArr.concat(fragArr);
      ownCount += fragArr.length;
    }
  }

  writeFileSync(targetPath, JSON.stringify(target, null, 2) + '\n', 'utf8');
  return { ownCount, removedCount };
}

// ---------------------------------------------------------------------------
// worktree-baseref：P1（DESIGN §7）——官方預設從遠端預設分支開 worktree，worker 看不到
// 本輪未推送的票與凍結名單，凍結守衛在 worker 端因此放行。使用者沒設過 worktree.baseRef
// 這個鍵才寫成 "head"；已設過任何值都不動。
//
// 標記放哪裡：官方 schema 對 worktree 物件是 additionalProperties:false（多塞一個
// _constellation 旗標進去，會被判成不認得的欄位），所以旗標改打在 target 頂層的
// _constellation 物件（頂層 additionalProperties:true，安全）——沿用既有的 _constellation
// 標記慣例（同一個鍵名，標「這是 Constellation 寫的」），只是換到不會撞官方 schema 的位置。
// mode=uninstall 時只憑這個旗標判斷要不要刪：旗標不在就什麼都不動（表示這個值不是我們寫的，
// 可能是使用者自己設的），旗標在才刪掉 baseRef（以及旗標本身），刪完各自的容器物件變空就
// 一併拿掉，不留 "worktree": {} 或 "_constellation": {} 空殼。
// 對抗複審 M1：旗標只證明「我們裝過」，不證明「現在這個值還是我們寫的那個」——使用者裝完後
// 自己把 baseRef 改成別的值，卸載不能連使用者改過的值也一起刪掉。所以卸載只在值仍是我們寫入
// 的字面 "head" 時才刪值，旗標永遠都刪（旗標本身就是我們的東西）。反過來，使用者裝完後把
// baseRef 整個刪掉、只留下旗標（想退回官方預設），重裝時鍵不在但旗標在，代表這是使用者主動
// 退出，不是「從未裝過」，一律 skip、不重新寫回；旗標留著，不然下次又會被誤判成全新安裝。
// ---------------------------------------------------------------------------
export function setWorktreeBaseRef(targetPath, mode) {
  let target = readJson(targetPath, {});
  if (!isPlainObject(target)) target = {};

  let action;

  if (mode === 'uninstall') {
    const owned = isPlainObject(target._constellation) && target._constellation.worktreeBaseRef === true;
    if (owned) {
      if (isPlainObject(target.worktree) && target.worktree.baseRef === 'head') {
        delete target.worktree.baseRef;
        if (Object.keys(target.worktree).length === 0) delete target.worktree;
      }
      delete target._constellation.worktreeBaseRef;
      if (Object.keys(target._constellation).length === 0) delete target._constellation;
      action = 'removed';
    } else {
      action = 'skip';
    }
  } else {
    const hasBaseRef = isPlainObject(target.worktree) && typeof target.worktree.baseRef !== 'undefined';
    const previouslyOwned = isPlainObject(target._constellation) && target._constellation.worktreeBaseRef === true;
    if (hasBaseRef) {
      action = 'already-set';
    } else if (previouslyOwned) {
      action = 'skip';
    } else {
      if (!isPlainObject(target.worktree)) target.worktree = {};
      target.worktree.baseRef = 'head';
      if (!isPlainObject(target._constellation)) target._constellation = {};
      target._constellation.worktreeBaseRef = true;
      action = 'written';
    }
  }

  writeFileSync(targetPath, JSON.stringify(target, null, 2) + '\n', 'utf8');
  return { action };
}

// ---------------------------------------------------------------------------
// CLI（用 import.meta.url 守衛：測試檔要 import mergeHooks 直接呼叫，不能讓 import 動作本身
// 就跑進這段 CLI 分派、對著測試跑者自己的 process.argv 誤判成用法錯誤而 process.exit(1)）。
// ---------------------------------------------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [, , sub, ...rest] = process.argv;
  if (sub === 'merge-hooks') {
    const [targetPath, fragmentPath, mode, rootPath] = rest;
    process.stdout.write(JSON.stringify(mergeHooks(targetPath, fragmentPath, mode, rootPath)));
  } else if (sub === 'worktree-baseref') {
    const [targetPath, mode] = rest;
    process.stdout.write(JSON.stringify(setWorktreeBaseRef(targetPath, mode)));
  } else {
    console.error('用法：node install-hooks.mjs merge-hooks <target> <fragment> merge|uninstall <root>');
    console.error('      node install-hooks.mjs worktree-baseref <target> merge|uninstall');
    process.exit(1);
  }
}
