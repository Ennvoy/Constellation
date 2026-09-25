#!/usr/bin/env node
// gates/lease.mjs — 跨 session／跨專案共用同一台機器的「使用中燈」（machine 鎖）。DESIGN.md §5／決議 026。
// 它是工具不是閘門（比照 gates/serve.mjs）：不擋任何動作，只提供「搶／查／釋放」這把鎖的最小操作，
// 供 gates/verify-runner.mjs 的 `--scope ship` 呼叫（開跑前搶鎖、被佔就排隊，見該檔的 acquireShipLease）；
// 也單獨當 CLI 用，但只開放 `list`（列出誰佔著、做什麼、預估幾點結束）。
//
// 背景：兩個專案共用同一支 verify-runner.mjs，命令列長得一模一樣，出貨全量互相看不見對方，
// 只能靠跨 session 聊天協調——曾經連續兩次把對方正在跑的出貨全量當孤兒殺掉，也曾經沒有機器可查、
// 空等 158 分鐘（來龍去脈與拍板見 .constellation/decisions/026-cross-session-machine-lease.md）。
//
// 設計只有一把鎖，範圍是整台機器（不分專案）：登記檔 ~/.constellation/leases/machine/holder.json，
// 用 fs 的 'wx' 旗標建立（檔案已存在就失敗＝搶鎖失敗）——天生排他，不必額外的檔案鎖或資料庫。
// 身分＝pid＋行程啟動時間，沿用決議 020 同一套識別，不另外發一組 token：
//   - 搶鎖成功時把自己的 pid 與啟動時間寫進登記；呼叫端（verify-runner.mjs）全程只用同一份
//     識別物件（一次算好、不重算），釋放／改欄位時都拿它來比對「這份登記還是不是我」。
//   - 失效判定完全不碰持有方的行程本身：pid 已死，或（較貴的）行程啟動時間對不上，兩者都只把
//     登記檔改名作廢，讓下一個搶鎖的人重新 `wx` 建檔——絕不殺持有方的行程（決議 020 精神）。
//   - 改名／釋放前一定重讀一次登記檔，確認「現在這一筆」仍是原本判定失效／要釋放的那一筆，
//     免得把「這一瞬間剛換上的新持有者」或「原持有者其實還活著、只是判斷失誤」的登記誤刪。
// 判死活、要不要等、等多久都是呼叫端的事——本檔只管登記檔本身的讀寫與身分比對，不含輪詢迴圈、
// 不含心跳、沒有排隊目錄、沒有 `lease run`／`lease wait`（這些延到第二版，見決議 026）。
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// ---------------------------------------------------------------------------
// 登記檔路徑：機器層級（不分專案）。homedir() 每次呼叫都重新查——測試靠改 USERPROFILE／HOME
// 環境變數就能整組導去拋棄式假家目錄，不必額外的路徑注入參數。
// ---------------------------------------------------------------------------
const leaseDir = () => join(homedir(), '.constellation', 'leases', 'machine');
const holderPath = () => join(leaseDir(), 'holder.json');
const staleMarkerPath = () => join(leaseDir(), 'holder.json.stale'); // 失效登記改名到這裡，只留最近一筆

function readHolder() {
  try {
    const parsed = JSON.parse(stripBom(readFileSync(holderPath(), 'utf8')));
    if (parsed && typeof parsed === 'object' && parsed.pid != null) return parsed;
  } catch {}
  return null;
}

// 被動查一次目前狀態，不嘗試搶鎖（不寫入任何東西）：呼叫端排隊等待時每一輪拿來重新整理現況用。
// 跟 acquire() 的 EEXIST 分支回傳同一種形狀（{holder} / {corrupt,mtimeMs} / {}），但絕不觸發 wx
// 寫入——呼叫端如果把「查現況」跟「嘗試搶鎖」混在同一個回傳值裡處理，會分不出「這次查到的是
// 原本就在的舊持有者」還是「我自己剛剛才搶到、還沒被自己認出來」，見 verify-runner.mjs 的教訓。
function peekHolder() {
  const holder = readHolder();
  if (holder) return { holder };
  if (!existsSync(holderPath())) return {};
  let mtimeMs = null;
  try { mtimeMs = statSync(holderPath()).mtimeMs; } catch {}
  return { corrupt: true, mtimeMs };
}

// 進程是否還在。EPERM＝存在但沒權限查，一樣算還在（同 serve.mjs／決議 020 的判準）。
function isPidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

// 這個行程自己的啟動時間（毫秒）：process.uptime() 是「已經跑了幾秒」，反推回啟動時刻。
// 只是估計值（本身有量測誤差），呼叫端只在搶鎖那一刻算一次、全程沿用同一個值，
// 不要每次重算——否則同一個行程前後兩次算出來的值會有微小飄移，比對識別時徒增誤判空間。
function myStartedAtMs() {
  return Date.now() - Math.round(process.uptime() * 1000);
}

// 短暫同步等待，只給下面兩個函式的 EPERM/EBUSY 重試用（Windows 防毒掃描常見）。
// 'exit' 事件處理器不能是 async，所以這裡用 Atomics.wait 做同步忙等，不能用 setTimeout。
function sleepSyncMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

// 搶鎖：wx 旗標建立成功即拿到；EEXIST 代表已有人持有，回傳目前持有者供呼叫端判斷要不要等。
// 目錄／檔案寫不進去（權限問題等，非 EEXIST）時把例外原樣丟出，呼叫端決定要不要 fail-open
// （verify-runner.mjs 的作法：印警告、不排隊、直接照跑）。
function acquire(entry) {
  mkdirSync(leaseDir(), { recursive: true });
  try {
    writeFileSync(holderPath(), JSON.stringify(entry, null, 2), { encoding: 'utf8', flag: 'wx' });
    return { ok: true };
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      const holder = readHolder();
      if (holder) return { ok: false, holder };
      // 檔案在，但解析不出來（例如寫到一半就被 taskkill／TaskStop 打斷，留下 0 位元組或半截 JSON）。
      // 光看「holder 是 null」分不出「真的沒人」和「壞掉的登記還卡著」——附上 mtime，讓呼叫端自己
      // 決定卡多久才當失效（見下面 invalidateCorrupt）。
      let mtimeMs = null;
      try { mtimeMs = statSync(holderPath()).mtimeMs; } catch {}
      return { ok: false, holder: null, corrupt: true, mtimeMs };
    }
    throw err;
  }
}

// 判失效即改名作廢，絕不殺持有方的行程（決議 020 精神）。expectedHolder 是呼叫端剛判定失效的
// 那一筆快照——動手前重讀一次現況，只有「現在的登記仍是那一筆」（pid＋啟動時間都對得上）才真的
// 改名，避免把這一瞬間剛換上的新持有者一起作廢掉。只留最近一筆失效紀錄（同名覆蓋），不累積。
function invalidate(expectedHolder) {
  for (let i = 0; i < 3; i++) {
    const cur = readHolder();
    if (!cur) return true; // 已經被別人清掉／換掉，視為成功
    if (Number(cur.pid) !== Number(expectedHolder.pid) || Number(cur.startedAt) !== Number(expectedHolder.startedAt)) {
      return true; // 現在的登記不是原本判定失效的那一筆，不能動它
    }
    try {
      try { unlinkSync(staleMarkerPath()); } catch {}
      renameSync(holderPath(), staleMarkerPath());
      return true;
    } catch (err) {
      if (err && err.code === 'ENOENT') return true;
      if (i === 2 || !['EPERM', 'EBUSY'].includes(err && err.code)) return false;
      sleepSyncMs(50);
    }
  }
  return false;
}

// 損壞登記（檔案在但內容解析不出來）作廢：跟 invalidate() 分開處理，因為壞檔案沒有 pid／啟動時間
// 可比對身分——invalidate() 一律用 readHolder() 判斷「現在是不是原本那一筆」，對壞檔案永遠讀不到
// 內容，會誤判成「已經被清掉」而不動手，讓壞檔案卡住不放（呼叫端要多久才判定壞到可以清，見
// verify-runner.mjs 的 CORRUPT_STALE_MS）。動手前重讀一次，若這時已經變成讀得懂的合法登記
// （別人剛好接手），就不要誤刪它。
function invalidateCorrupt() {
  if (readHolder()) return true;
  for (let i = 0; i < 3; i++) {
    try {
      try { unlinkSync(staleMarkerPath()); } catch {}
      renameSync(holderPath(), staleMarkerPath());
      return true;
    } catch (err) {
      if (err && err.code === 'ENOENT') return true;
      if (readHolder()) return true; // 這段時間被別人換成合法登記了，不要動
      if (i === 2 || !['EPERM', 'EBUSY'].includes(err && err.code)) return false;
      sleepSyncMs(50);
    }
  }
  return false;
}

// 釋放：先比對這份登記是不是自己（pid＋啟動時間都對得上）才動手，避免刪掉「自己被誤判失效後
// 別人剛搶到」的新登記。EPERM/EBUSY 短暫重試；仍失敗就放棄——留著的登記會被下一個等待者的
// 失效判定自然收拾掉，不影響安全性，只是慢一點被回收。
function release(identity) {
  for (let i = 0; i < 3; i++) {
    const holder = readHolder();
    if (!holder) return true; // 已經不在了，視為成功
    if (Number(holder.pid) !== Number(identity.pid) || Number(holder.startedAt) !== Number(identity.startedAt)) {
      return true; // 不是自己的登記，不動它
    }
    try {
      unlinkSync(holderPath());
      return true;
    } catch (err) {
      if (err && err.code === 'ENOENT') return true;
      if (i === 2 || !['EPERM', 'EBUSY'].includes(err && err.code)) return false;
      sleepSyncMs(50);
    }
  }
  return false;
}

// 更新「目前子指令外殼 pid」：只有持有者自己會呼叫，且只在身分仍對得上時才寫入——避免在等待
// 失效判定的空窗期把別人剛搶到的登記蓋掉一個無意義欄位。寫入失敗（IO 問題）不影響主流程。
function updateShellPid(identity, shellPid) {
  const holder = readHolder();
  if (!holder) return;
  if (Number(holder.pid) !== Number(identity.pid) || Number(holder.startedAt) !== Number(identity.startedAt)) return;
  try {
    writeFileSync(holderPath(), JSON.stringify({ ...holder, shellPid }, null, 2), 'utf8');
  } catch {}
}

// 預估結束時間：取該專案上一次 ship 證據的總耗時（證據筆裡「- 耗時：合計 Ns｜…」那一行），
// 加到現在。找不到證據檔／解析不出耗時就回 null——呼叫端顯示「無法預估」，不用猜的數字誤導人。
function estimateEndFromShipEvidence(cwd) {
  try {
    const content = stripBom(readFileSync(join(cwd, '.constellation', 'ship-evidence.md'), 'utf8'));
    const matches = [...content.matchAll(/耗時：合計 (\d+)s/g)];
    if (!matches.length) return null;
    const lastSec = Number(matches[matches.length - 1][1]);
    return Number.isFinite(lastSec) ? new Date(Date.now() + lastSec * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

// 人看的一行摘要：list 指令與 runner 排隊訊息共用。時間一律印本地時間（不印 UTC ISO）——
// 這份摘要是給人看「大概幾點」，跟守門擋下訊息裡的本地 HH:MM 對齊，不要兩邊看到的時區不一樣。
// 「起於」優先顯示 grantedAt（真正搶到鎖、開始跑的那一刻）；沒有這欄位（舊格式或呼叫端沒填）
// 才退回 startedAt（行程本身的啟動時間，可能是排隊排了很久之前）。
function formatHolder(holder) {
  const aliveText = isPidAlive(holder.pid) ? '存活' : '（PID 已不在，判定失效中）';
  const grantedTs = holder.grantedAt || holder.startedAt;
  const started = grantedTs ? new Date(grantedTs).toLocaleString() : '（不明）';
  const est = holder.estimatedEndAt ? new Date(holder.estimatedEndAt).toLocaleString() : '（無法預估）';
  return [
    `  專案：${holder.root || '（不明）'}`,
    `  用途：${holder.purpose || '（未說明）'}`,
    `  session：${holder.session || '（不明）'}　runtime：${holder.runtime || '（不明）'}`,
    `  PID ${holder.pid}${holder.shellPid ? `／目前子指令外殼 PID ${holder.shellPid}` : ''}　${aliveText}`,
    `  起於 ${started}　預估結束 ${est}`,
  ].join('\n');
}

export {
  leaseDir, holderPath, readHolder, peekHolder, isPidAlive, myStartedAtMs,
  acquire, invalidate, invalidateCorrupt, release, updateShellPid, estimateEndFromShipEvidence, formatHolder,
};

// ---------------------------------------------------------------------------
// CLI：只開放 list（給人看誰佔著、做什麼、預估幾點結束）。
// ---------------------------------------------------------------------------
function cmdList() {
  const holder = readHolder();
  if (!holder) {
    // 檔案在但讀不出來（壞掉／寫到一半），跟「真的沒人」講清楚是兩回事——照實說出來，
    // 不要讓人誤以為機器是空的（S2：曾經因此讓全量默默卡滿 4 小時 max-wait 都不吭聲）。
    if (existsSync(holderPath())) {
      console.log(`機器鎖登記檔存在但讀不出來（可能壞掉或正寫到一半）：${holderPath()}`);
    } else {
      console.log('目前沒有人持有機器鎖。');
    }
    return 0;
  }
  console.log(`機器鎖持有中（${holderPath()}）：`);
  console.log(formatHolder(holder));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const sub = process.argv[2];
  if (!sub || sub === 'list') {
    process.exit(cmdList());
  } else {
    console.error(`用法：node "${fileURLToPath(import.meta.url)}" list`);
    process.exit(1);
  }
}
