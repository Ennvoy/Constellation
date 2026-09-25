# Phase ④ 逐票實作（build）

一句話：領票→紅測試→做綠→實跑驗證→關票，無 blocked-by 依賴的票就各自開 worktree 平行做。

## 進場 / 離場

- **進場條件**：本檔同目錄的 `phase-weave.md` 產出的票清單（或小流程單一任務卡）已經使用者確認。
- **離場條件**：所有票 `status: done`（驗證證據齊全、閘門放行）→ 交棒給本檔同目錄的 `phase-ship.md`。

## 單票內部循環（不論平行與否，每張票都走這個循環）

1. **領票**：挑一張 `status: open` 且 `blocked-by` 已全部 `done` 的票（走小流程時就是那一張任務卡），領票當下就把 `status` 改成 `in-progress`——不是留著 `open` 到關票才一次改，讓其他人／其他 session 讀檔就知道這張正在做。
2. **測試先行**：在票的驗收條件對應的 seam 上先寫失敗測試（輕量 TDD）。垂直切片——一個驗收條件對一段測試，不要整票功能一次寫完才開始實作。每條測試動筆前先問「更低一層能不能抓到同一個 bug」——能就往下放；技術形態照本檔同目錄 `verification-playbook.md`「真鏈路也要快」的效率鐵則（最低層原則、少往返、登入態重用），新增 e2e 測試在票的決議記錄留一句「為什麼低層測不到」。
3. **實作轉綠**：讓剛剛寫的測試通過。這條驗收條件真的實跑通過後，就在票的「驗收條件」把它勾 `[x]`——垂直切片、跑綠一條勾一條，不是等整張票都做完才一次補勾。
   - **禁 tautological test**：測試的期望值不能用跟實作一樣的算法算出來——那等於沒測。
   - **禁 mock 冒充真依賴**：測試要打真依賴（真 DB、真 API、真檔案系統）。依賴還沒 ready（外部服務未接、其他票的介面還沒做完）就把**這張票**標 `blocked`（原因寫進決議記錄，講清楚卡在哪個依賴），不能用 mock 假裝過關。
   - 同一個地方反覆卡住修不動：走本檔同目錄的 `debugging-loop.md` 那套排查節奏，不要在原地無限重試。
4. **實跑驗證落證據**：跑驗證 runner——絕對路徑由 session 開場注入提供（閘門 3 開場會印出這個路徑）；session 沒印出注入路徑時，用 install 部署的母本路徑 `<母本>\gates\verify-runner.mjs`。逐票跑法：`node <runner 絕對路徑> --ticket <票號> --scope ticket`——票內有「## 驗證指令」縮圈清單（weave 寫定）時 runner 跑該清單取代 `commands.test`，省略則跑 `commands.test` 全量；外加這張票驗收條件對應的實跑檢查，不跑 `commands.journey`（那留到 ship 全量一次跑）。**驗證失敗不得靠改窄縮圈清單洗綠**——該修的是 code；要調整清單（漏涵蓋、影響面變了）須在票的決議記錄留一筆原因。runner 會把指令、結果摘要、時間戳與簽章寫進票的「驗證證據」欄——這欄人不手填，手填等於繞過閘門。執行細節見本檔同目錄的 `verification-playbook.md`。
   - **斷路器**：runner 內建同一張票連續 5 次失敗即強制停下，不會無限重試。撞到這個狀況時，整理目前卡在哪、已經試過什麼，彈窗請使用者拍板下一步（是換排查方向、還是這張票該標 `blocked`）——**不得刪掉 runner 的失敗計數檔硬闖**，那等於把斷路器繞過，失去它原本要擋的「同一個坑一直踩」的保護。`--scope ship` 的斷路器計數以 `.constellation/ship-evidence.md` 是否存在判定新一輪——出貨歸檔移除它是合法重置，期間手動刪它等同刪計數檔硬闖，一樣不行。
5. **關票**：runner 綠燈後，把票的 `status` 改 `done`。閘門 5（關票刷卡機）會檢查驗證證據是否存在且夠新鮮，證據不足直接擋下，不能手動繞過。
   - **測試整理**：關票前，把 TDD 過程中為驅動實作寫的中間測試（測內部函式的中間值、mock 內部模組、斷言呼叫次數、測 private helper）刪掉或併入；留下的是每條驗收條件對應一支「給輸入看輸出／打 API 看回應／查 DB 看結果」的行為測試，數量以驗收條件數為準，不無限累積。細則見本檔同目錄的 `verification-playbook.md`「關票前的測試整理」。
   - **解凍檔案要回凍**：本票期間解凍過的檔案（`design-frozen.json` 的 `log` 有這張票號的 `unfreeze` 記錄），關票前必須回到 `frozen`（`log` 有對應 `refreeze`），或在票的「決議記錄」寫明這個路徑為什麼不回凍——閘門 5 會機器驗這條，未回凍又沒寫明一律擋下。走「決議記錄寫明不回凍」這條出路時，閘門會同時看這次編輯內容與磁碟現檔，所以說明先寫進票檔再改 status 也可以，不必硬擠在同一次編輯裡一起寫。
   - **結構變動記決議記錄，地圖留到 ship 收尾**：這張票如果新增／搬移了模組或目錄、新增或刪除了資料表、補掉或拆掉了 `.constellation/MAP.md` 第三段的某個缺口地雷，在票的「決議記錄」記一行即可；地圖統一在 `phase-ship.md` 步驟 3 收尾校對一次，build 期不動 `MAP.md`。
6. **Commit**：把這張票的程式改動**與票檔本身**（`status` 改 `done`、驗證證據、決議記錄的變更）一起納入**同一個** commit，訊息描述這張票做了什麼（不是逐檔羅列變更）——不是「commit 完才回頭關票」，避免關票狀態遊離在 commit 之外，讓票的狀態與 git 歷史對不上。

## 平行編排（無 blocked-by 依賴就 worktree 平行）

- **條件**：這批票彼此之間沒有 `blocked-by` 關係 → 可同批 fan-out。**依賴接力**：前置票一關票，依賴它的票就開工，不等同批其他票；前置票沒關票（含「部分驗證、暫不關票」）的下游不開工，列進回報（細節見下面「序列整合」）。**不再劃 `zone` 互斥、不再算誰能跟誰平行**：每個 worker 用 Workflow 的 `isolation: 'worktree'`，在自己的 git worktree 裡做，檔案天生隔開；票模板的 `zone` 欄降為可選，只用來讓「序列整合」檢查有沒有越界，不再是能不能平行的門檻。
- **委派下限**：1–2 次唯讀查詢主線自己做；不用 subagent 覆核自己剛完成的工作（獨立 context 的對抗審查是另一回事，照本檔同目錄 `phase-ship.md` 的兩軸審查規則走）；一個 subagent 能完成就不用多個。
- **開工前**：正文一句話講清楚本輪會平行幾張、依賴怎麼接（平行是 token 倍增，讓使用者知道成本）。
- **fan-out 前置確認**（母本 DESIGN.md §7「worktree 基底須含本輪產物」的落地步驟，這裡把動作寫清楚，不只留指標）：
  1. **本輪已本機 commit**：weave 核准票清單後應已 commit 本輪 `.constellation/` 產物與定稿改動（見本檔同目錄 `phase-weave.md`）；fan-out 前複查一次 `git status`，沒 commit 先補上——這是 worker 看得到最新票檔與凍結名單的前提。
  2. **worker 的 prompt 要寫進兩件事**：①開工第一步先確認自己要做的那張票檔存在於這個 worktree，不存在就回報、不要開工；②開工前先建好 `node_modules` junction（`cmd /c mklink /J node_modules <主專案根目錄>\node_modules`）——Workflow script 沒有檔案系統或執行指令的能力（見 `workflow-authoring` skill），worktree 路徑也要 worker 啟動後才拿得到，只有 worker 自己在場做得到這步，不整份複製、也不留到後面才補建。
  3. **第一次 fan-out 驗證分支基底**：任一 worker 分支跑 `git reflog show <分支>`，確認顯示 `Created from HEAD`；不是就停下回報主線（可能是 `worktree.baseRef` 沒生效，見 install 對賬），不要放著讓 worker 在舊基底上白做。
  4. 沒進版控但 worker 需要的檔（例如 `.env`、測試資料 CSV）用 `.worktreeinclude` 帶進 worktree。
- 用 **Workflow 工具** fan-out、每個 `agent()` 都帶 `isolation: 'worktree'`——這裡指 Claude Code 端內建的臨場編排工具，用來把這批票同時派給多個 worker、各自在自己的 git worktree 裡做，不是 repo 裡預先寫好的腳本檔案；worker 用便宜模型，各自跑上面「單票內部循環」的步驟 1～3（領票→測試先行→實作轉綠），外加自行以測試框架跑該票影響面的單點檢查（紅綠與煙霧，**不經 runner、不落證據**）——這個單點檢查需要 server 時經 `gates/serve.mjs` 起、跑完自己 `stop`（worker 手動起的 server 不在 runner 的清理範圍內；worktree 登記獨立、worker 收工前必須自己 `stop` 的細節見本檔同目錄 `verification-playbook.md`「臨時 server 的起與收」，這裡不重複）。這個單點檢查若開了 headless 瀏覽器（如 Playwright），收工只殺自己這個 worker 起的那支腳本（認起它時取的專屬檔名或記下的 PID，不是整個 worktree 或 session 共用的路徑），瀏覽器會跟著它連坐收掉——不得憑程式名或命令列路徑相同去掃殺，那會連平行 worker 或平行 session 正在跑的驗證一起殺掉（歸屬證據見同一節，決議 025）。worker 做完後在自己的分支 commit（訊息可以只寫 `wip`，**不把票的 `status` 改成 `done`**——關票是整合之後的事，領票時已經改成的 `in-progress` 不受影響）——沒有這步，下面「序列整合」合併時什麼改動都帶不過來。正式驗證（步驟 4）、關票與正式 commit 都留到下面「序列整合」統一做——整合前跑 runner 的簽章證明不了整合後的狀態，同一張票會白付兩次全價驗證（決議 012）。**Codex 端沒有 Workflow 工具**，依總控（`skills/constellation/SKILL.md`）的 runtime 降級對照，這批票改序列逐張做，不平行。
  - **每個 `agent()` 都要顯式寫 `model`**：script 裡沒寫 `model` 的 `agent()` 會默默繼承主迴圈模型（也就是最強最貴那個），上面那句「worker 用便宜模型」不會自動成立——每個 `agent()` 都是一次獨立的分派決定，漏一個就漏一個。建議在 script 開頭把 worker 模型寫成常數（例如 `const WORKER_MODEL = 'sonnet'`），讓分派意圖在腳本裡看得見，而不是散在各個 `opts` 裡憑記憶。
- **保護一：worktree 隔開檔案，合併回主線時還是可能真衝突**：兩個 worker 剛好改到同一支檔案，合併時撞到重疊 hunk——處理節奏見本檔同目錄的 `merge-conflicts.md`，不是退回重做（那是下面「越界」的處置，適用範圍不同）。
- **保護二：worktree 隔開檔案，隔不開資料庫**：多個 worker 的 worktree 通常還是打同一顆本機測試庫，worker 階段寫 DB 的檢查可以平行跑，資料隔離鐵則（票專屬前綴、只比對自己前綴範圍、禁止整表前後快照比對、紅燈先重跑一次）與起站埠怎麼傳進測試框架，見本檔同目錄 `verification-playbook.md`「測試資料衛生」，這裡不重複。本質上隔離不了的操作（套 migration／改 schema、整庫快照型資料保險、量級壓測）在票頭標 `exclusive:`（獨佔，見票模板）——**獨佔的意思是「單獨時段」，不是「留到序列整合做」**：序列整合期間其他 worker 仍在平行跑，migration 跟它們同時發生一樣不安全。遇到 `exclusive` 票，暫停派出新 worker，等當下所有還在跑 DB 檢查的 worker 都結束，這張票自己一個獨立做完（worker＋整合都跑完、DB 操作真的落地），才恢復正常平行派工。瀏覽器驗證用測試執行器自己開的瀏覽器（例如 Playwright 內建瀏覽器），不搶共用的瀏覽器 MCP 分頁。
- **序列整合**：一張張來，不要等所有 worker 都跑完才一次合併。**整合本身是一次 `agent()` 呼叫**（一樣要顯式指定 `model`，見上面「每個 `agent()` 都要顯式寫 `model`」）——Workflow script 自己沒有檔案系統或執行指令的能力，git 動作要靠這個整合 agent 的 Bash 去做，不是 script 直接呼叫某個 `run()` 函式。「一次只整合一張」實作成一條**互斥鏈**：一個從 `Promise.resolve()` 開始的變數，每張票的整合都接在它後面（`chain = chain.then(() => …)`），下一張要等上一張 resolve 才輪得到。**依賴接力要卡在派工前，不是卡在整合裡**：每張票配一個「已關票」的 deferred promise，worker 開工前先 `await` 它所有 `blocked-by` 票的那個 promise——前置票沒關票，依賴它的 worker 根本不會被派出去，不會出現「worker 已經在舊基底上做完，才在整合時才發現依賴沒過」這種白工。骨架示意（非完整 prompt、非可執行程式碼，不新增範本檔）：

  ```js
  const WORKER_MODEL = 'sonnet', INTEGRATOR_MODEL = 'sonnet';
  const doneOf = new Map(tickets.map(t => [t.id, deferred()]));   // 每張票一個「已關票」訊號
  let chain = Promise.resolve();                                  // 整合互斥鏈：永遠一張張來

  await parallel(tickets.map(ticket => async () => {
    await Promise.all(ticket.blockedBy.map(id => doneOf.get(id).promise)); // 依賴接力卡在這裡
    const worker = await agent(workerPrompt(ticket), { isolation: 'worktree', model: WORKER_MODEL });
    if (!worker) { doneOf.get(ticket.id).resolve(false); return; }
    chain = chain.then(() => agent(integratePrompt(ticket, worker),
      { model: INTEGRATOR_MODEL, schema: INTEGRATE_SCHEMA }));
    const result = await chain;
    doneOf.get(ticket.id).resolve(result?.ok === true);
  }));
  ```

  `integratePrompt()` 交給整合 agent、要它用 Bash 依序執行的固定順序：
  1. `git merge --no-ff --no-commit <worker 分支>`——一定要帶 `--no-ff`，否則可快轉時 HEAD 直接前進，下一步的越界檢查沒機會做。
  2. 這張票有宣告 `zone` 時，檢查有沒有動到 `zone` 之外的檔案——動了就 `git merge --abort`，交回主線（見第 4 步）；沒宣告 `zone` 的票略過這步。
  3. 跑這張票的正式驗證（同步驟 4）——這是這張票唯一一次經 runner 落證據的驗證，worker 階段只跑過測試框架的單點檢查，證據以整合後這次為準。
  4. **驗證沒過（含撞到斷路器）：一律先 `git merge --abort`**，讓 repo 回到合併前的乾淨狀態，**worktree 與分支都留著不清**——這條依賴鏈到此暫停，這張票與依賴它的下游票都不再往下走，交回主線裁決（換排查方向、還是標 `blocked`）；不能把合併停在進行中的狀態就丟著，那會讓下一張票的 `git merge` 直接失敗。
  5. 驗證綠燈才關票（票的 `status` 改 `done`）。
  6. 只 `git add` 這張票的票檔與整合時修正的檔（不用 `add -A`，免得把主工作樹裡無關的改動一起捲進去），`git commit -m "<這張票做了什麼>"`。
  7. **保護三：合併一張就收掉那張的 worktree，且順序不能反**——先 `cmd /c rmdir <worktree 路徑>\node_modules` 拆掉 junction（`Remove-Item -Recurse` 會把主專案的套件一起刪穿），**拆完才** `git worktree remove <worktree>`；最後 `git branch -d <分支>` 刪掉（帶 `--no-ff` 合併過，git 認得出已合併，刪得掉）。
  8. 才輪到下一張的合併（互斥鏈自動接手，不用手動排）。
  一張合併完直接領下一張、一批整合完直接領下一批；批與批之間不開「要不要繼續」彈窗，不提收工或換 session（決議 006）。
- **收尾核對**：這批票全部整合完，跑一次 `git worktree list` 與 `git branch --list 'worktree-*'` 確認零殘留——忘記收的 worktree 是完整 repo 副本會拖慢全庫搜尋、白佔磁碟；殘留分支多半是漏了第 7 步的 `branch -d`。這次收尾不必額外去找「還開著的 headless 瀏覽器」來清——瀏覽器是跟著直接控制它的那支 node 一起被系統連坐收掉的，查得到 `chrome-headless-shell.exe` 通常代表那支 node 還活著（多半是別人的），先用歸屬證據認過再處理，認不出就不要因為看到瀏覽器就動手清（細節見 `verification-playbook.md`「臨時 server 的起與收」，決議 025）。

## 實作期自駕分級

- **小事**（命名、邊界處理細節、實作路徑選擇）：自己拍板，寫進這張票的「決議記錄」，不用停下來問。
- **大事**（需求級分歧）：以下情況都要停下彈窗問使用者，不能自己決定：
  - 驗收條件互相矛盾（照著做會打架）。
  - 要動資料結構（schema 變更）。
  - 涉及權限、金流、個資 scope。
  - 破壞性 DB 操作（`DROP`／`TRUNCATE`／無 `WHERE` 的 `DELETE`/`UPDATE`）——包含把這類操作寫進測試的 setup／teardown／清理程式碼（測試執行時一樣會發生；測試資料的記號與清理範圍規則見本檔同目錄 `verification-playbook.md`「測試資料衛生」）。
- **平行 worker 遇到大事**：那張票標 `blocked` 並寫清楚卡在哪，其餘票繼續做、不用等它；主線把這批裡所有卡住的大事收集起來，一次跟使用者彈窗問清楚——不要每張票各自彈一次窗。
- **大事拍板後即時落檔**：彈窗拿到的答案屬取捨型拍板 → 當場寫一筆 `.constellation/decisions/NNN-slug.md`（背景＋決定＋原因＋證據，見總控 SKILL.md「拍板即落檔」通則），再回頭繼續實作；只寫進當下對話不落檔，下個 session 就蒸發。

## 撞到凍結怎麼辦

**預授權例外**：design 定稿記錄列了「預授權檔案清單」的檔案，遇到換寫死值、接真 API、加純資料 prop 這類**不改版面與互動**的改動，不必走下面的彈窗流程——預授權取代的是彈窗、不是取代解凍動作，順序仍是三步：①先把該路徑從 `.constellation/design-frozen.json` 的 `frozen` 陣列移除、同時在 `log` 補一筆 `unfreeze`（`reason` 寫「依定稿記錄預授權：T-XXX 接真資料」、`ticket` 欄寫這張票的票號，這一步不必彈窗）→ ②改檔 → ③把路徑補回 `frozen`、`log` 補一筆 `refreeze`（`ticket` 欄同樣寫這張票的票號）。閘門 5 在編輯當下只看路徑在不在 `frozen`——不在就放行；關票（`status: done`）時閘門 5 才驗 `log` 的 `unfreeze`／`refreeze` 是否配對，且只認**這張票自己**寫的 `ticket` 欄（沒寫 `ticket` 欄的舊記錄不分票，任何票關票都會核對到）。**越出這份清單、或動到版面與互動視覺，才走下面的四步彈窗流程。**

實作中發現需要改到 design 階段定稿凍結的元件（`.constellation/design-frozen.json` 的 `frozen` 名單內，見本檔同目錄的 `phase-design.md` 步驟 7「收尾——寫定稿記錄、定稿即凍結」）——例如接資料時發現定稿元件缺一個欄位、需要調整 props 介面——**這屬於「大事」，不能自己動手改**，即使改動看起來很小。實測上，任何 Edit／Write／apply_patch 對凍結檔案的操作都會被閘門 5（關票刷卡機）機器擋下，不會意外改成功。

處理節奏（清單外、或動到版面互動視覺的情況）：

1. **停下彈窗**：用 AskUserQuestion 講清楚三件事——要改哪個檔（給出 `frozen` 名單裡的路徑）、為什麼需要改（例如「接 API 後發現缺 `avatarUrl` 欄位的顯示位置」）、影響範圍（純加欄位／改版面結構／其他）。
2. **使用者同意**：把該檔的路徑從 `.constellation/design-frozen.json` 的 `frozen` 陣列移除，並在 `log` 陣列補一筆 `unfreeze`（含原因、時間戳、這張票的票號）：
   ```json
   { "path": "src/components/LoginForm.tsx", "action": "unfreeze", "at": "<ISO 時間戳>", "reason": "接 API 後缺 avatarUrl 顯示位置，使用者同意調整", "ticket": "T-012" }
   ```
   移除後這個檔案才解除機器擋下，可以正常編輯。`ticket` 欄讓關票刷卡機把「解凍後還沒回凍」的檢查限縮在這張票自己造成的部份，不會被同輪其他票的解凍狀態誤擋。
3. **改完**：若這次改動屬於視覺層調整（版面、互動、外觀有變化）——請使用者再次過目，過目通過後把該檔路徑補回 `frozen` 陣列、在 `log` 補一筆 `action: "refreeze"`（原因寫這次調整了什麼、`ticket` 欄同樣寫這張票的票號）。若只是介面層小補（例如純加一個內部沒有視覺變化的 prop），可以視情況直接 refreeze，不強制每次都要使用者重新走一次視覺確認，但仍要留 `refreeze` 記錄。
4. **使用者不同意**：這張票依既有規則標 `blocked`（決議記錄寫清楚卡在哪）或改走不動定稿的替代方案，不能繞過使用者硬改。

**明令：不得未經同意自行解凍**——`log` 是審計軌跡，出貨審查（`phase-ship.md`）的 Spec 軸會核對每筆 `unfreeze` 是否對應得上使用者同意的脈絡（例如某張票的決議記錄、或彈窗當下的對話紀錄），沒有對應同意脈絡的解凍視為阻擋級發現。
