# 023 母本健檢：六題拍板，連帶修訂 017／019／020／021／022

背景：以 8 個應用專案的 transcript、票檔、決議、歸檔與本機實測對母本做全面健檢——60 條發現經逐條實測對抗審查，45 條採納、併成 25 項改動，15 條否決。其中 6 項動到使用者體驗或既有拍板，逐題請使用者拍板（即本決議）；其餘 19 項屬技術修正、精簡與文件同步，由執行端分四波落地（閘門程式修正與回歸測試→憲法同步→skill 條文與相依程式→簽章共用模組），內容見各波 commit 與 `HISTORY.md`，不在此逐列。

決定：

- **P1 worker 工作區基底**：`install.ps1` 在使用者沒設過時把 Claude Code 使用者層設定 `worktree.baseRef` 寫成 `head`、卸載時只移除自己寫入的那筆；不採「每個 worker 開工先自己同步」。配套：票清單核准即同意一次本機 commit（本輪 `.constellation/` 產物與定稿改動，不推送）；worker 開工先確認票檔在工作區；首次 fan-out 以 worker 分支 reflog 驗收。
- **P5 畫面定稿**：5b 改為執行端經 `serve.mjs` 起正式頁面、逐一點過每個互動（含載入／空／錯誤三態），每個畫面整頁截圖（不裁切、遮個資）＋逐互動結果發私人 Artifact，使用者看圖拍板、仍可隨時要本地網址自己點；「不可代為拍板」保留，「已改未重截」不算定稿。瀏覽器工具或 Artifact 任一缺（Codex 端兩者都沒有）就退回使用者本地點。
- **P7 worktree 清理時機**：以「合一張收一張」（DESIGN §7 保護三現行條文）為準，不採 022⑧ 的「全部票合併完再清」。
- **P8 平行寫 DB 的檢查**：照資料隔離鐵則同時跑（票專屬前綴、只比對自己前綴、禁整表前後快照比對、平行時的紅燈先單獨重跑再判定）；只有套 migration／改 schema、整庫快照型資料保險、量級壓測標「獨佔」排隊。
- **P11 MAP／CONTEXT 字數預算**：MAP 缺口／地雷每條至多 2 句（保留行內來源路徑）、細節指向決議；CONTEXT 不寫版本註記與規格內文；超出預算時開場必讀句加註一句，下一次 ship 校對地圖時兩檔一併壓回（壓縮不是刪除）。
- **P12 流程外門檻**：拿掉「預計動不超過 3 個檔」，改「一個連貫改動、主線或單一工作流做得完」；保留不動資料結構／權限／凍結名單，動 migration 或權限走小流程；`HISTORY.md` 那一行註明有無獨立審查、全量測試結果。

連帶修訂既有決議（原檔內容保留，衝突處以本決議為準）：

- 017①（5b 使用者親自點、不可用截圖）與「雙 runtime」段（5b 主體兩邊一樣、不降級）→ 由 P5 取代。
- 017③ weave 進場三驗的「本地拍板紀錄」→ 改驗 Artifact 連結＋逐互動結果；退回使用者本地點時為拍板回覆原文＋逐區塊元件清單。
- 017⑤ 哨兵觸發條件「且已有定稿記錄」→「且 `tickets/` 已有票」；目的（抓「weave 放行但沒凍結」）不變。
- 019「不加任何機制」→ 由 P11 重開；措辭部分（查詢型 session 也要讀、附地雷條數）不變。
- 020 落地補記「subagent 經它起的登記記在 subagent 名下」前提有誤：subagent 與主 session 共用同一個 session_id，主 session 收不到的原因是登記檔位置——worktree 帶著 `.constellation/` 時（P1 之後即為常態）登記寫進 worktree 自己的 `.servers.json`，worktree 一移除就消失；不帶時往上落到主 repo 的登記檔。結論「worker 收工前自己 stop」不變，補「移除 worktree 前也要 stop」。另據實下修兩處：reap 認不出 session 時是「不殺也不刪」（非「只清已死登記」）；Codex 端 SessionEnd 上限 3 秒、reap 有登記要收時跑不完，實際只有 Claude Code 端在收。
- 021②「定版點（5b 使用者親自點過）一字未動」→ 由 P5 取代。
- 022④「預計動不超過 3 個檔」→ 由 P12 取代，其餘安全條件不變；022⑧ 的清理時機 → 由 P7 取代，其餘（預設 worktree 平行、不預先劃界線）不變。

否決 15 條（執行端判斷、未經拍板，記下以免重提）：close-gate 改常駐行程（安靜時冷啟僅 0.26–0.43 秒）、PreToolUse 以 `if` 篩 git（實測漏放 7 種指令形狀）、熱路徑小函式抽共用檔（閘門一壞全壞）、要求 worker 照抄驗證指令（已照抄，紅燈是環境差異）、預授權自動刪 worktree 分支（架空閘門 1 的同意機制）、平行假設除錯各開 worktree（官方支援的是唯讀調查）、凍結日誌改 JSONL（成本遠大於收益）、兩份 hooks json 合一（SessionEnd 逾時已必須分岔）、model 分派閘門搬進母本（使用者個人 hook 已涵蓋且更廣）、訪談收尾併成一題（違反決議 013）、官方 /skill-doctor 稽核（量不到 reference 讀取量）、重查 10,000 字元上限出處（官方原文確有）、關票改以編輯後內容判定（CRLF 票檔下反而放行）、執行期狀態檔追蹤清理（實害僅一個計數檔）、grill-close 兼當輪次規格（換 session 後執行端自決無落點）。

原因：

- P1：官方預設從遠端預設分支開 worktree，worker 看不到本輪未推送的票與凍結名單，凍結守衛在 worker 端讀不到名單而放行；改成預設行為，不靠每個 worker 的紀律。代價是使用者層設定影響所有專案的 worktree。
- P5：使用者在兩個專案、三天內兩次明講不要自己點，兩專案已各自開成例外；017 的核心（交付物是正式 code、使用者看到真實畫面）不受影響。代價是執行端用量額度、截圖可能藏住區塊或帶出個資，以整頁不裁切、逐互動清單、已改未重截不算定稿兜住。
- P7：依賴接力下「全部合完才清」會讓 worktree 堆好幾小時，每個都是完整 repo 副本、拖慢全庫搜尋。
- P8：原條文「寫 DB 的測試序列跑」在平行 worker 之間沒有協調機制、實際做不到；整段序列化會讓 DB 重的票退化成單工，違背決議 018。
- P11：兩檔寫入沒有長度上限、隨專案年齡一路長，「整份讀」的成本已過高、CONTEXT 已讀不完；019 的成本帳只算了注入多出的 92 字元，沒算讀檔。
- P12：022④ 核准時舉的五個例子全超過 3 檔，照條文一例都走不了流程外；安全條件要留，因為五例中唯一動了 migration 的那條正好沒做審查。

證據：

- 拍板脈絡：母本 session `bcfe2ca2-373c-4737-8458-c4650e23d86c`（2026-09-24）逐題彈窗，題目原文 → 所選選項原文：
  - P1「第1題：平行 worker 的工作區預設從「遠端」舊版開，看不到本輪的票（hub、crm 都踩過）。要怎麼讓 worker 從本機最新版開？」→「改全域設定從本機開（推薦）」
  - P5「第2題：畫面定稿改成執行端自己點過每個互動、整頁截圖放私人網頁，〔使用者〕看圖拍板（仍可隨時要本地網址自己點）？」→「改成看圖拍板（推薦）」
  - P7「第3題：決議 022 〔使用者〕選「全部票合完才清 worktree」，條文卻寫「合一張收一張」，兩邊矛盾。以哪個為準？」→「合一張收一張（推薦）」
  - P8「第4題：worker 平行時寫資料庫的檢查，改成照資料隔離規則同時跑、只有 migration 這類才排隊？」→「照資料隔離同時跑（推薦）」
  - P11「第5題：MAP.md／CONTEXT.md 設字數上限，超過時開場提醒、下次出貨壓回？（crm MAP 已 209KB、line工具 CONTEXT 讀不完）」→「設上限，出貨時壓回（推薦）」
  - P12「第6題：流程外小改動拿掉「最多 3 個檔」（當初核准用的 5 個例子全超過），保留不動資料結構／權限／凍結畫面三條？」→「拿掉 3 檔限制（推薦）」
- 當時依據：
  - P1：https://code.claude.com/docs/en/worktrees 原文「"fresh" (default): branch from the repository's default branch on the remote」「"head": branch from your current local HEAD, so the worktree carries your unpushed commits」；AI_project_hub `git reflog show worktree-wf_dbc21821-8f1-11` 為「Created from origin/main」、基底 cd8ac87 沒有 `tickets/` 與 `design-frozen.json`，本機 main 領先遠端 10 個 commit；crm-system 10 條 worker 分支 reflog 全為「Created from origin/main」。
  - P5：crm-system round-0915 使用者答「你不要叫我點，應該你點然後截圖給我看」（2026-09-21）；AI_project_hub 使用者答「你不要等我點你應該自己點來驗證啊，我只要確認畫面」（2026-09-23，該專案決議 273）；反例：crm T-141 截圖裁切漏掉「完成趟數」一欄。
  - P7：022⑧ 原文與 DESIGN §7 保護三字面相反；crm-system 累積 17 條已合併的 `worktree-*` 分支。
  - P8：AI_project_hub pipeline 腳本給 worker 的規則「其他票可能同時在寫正式庫，你的檢查只能用自己的前綴範圍判斷，不要做整表前後快照比對」，同輪 weave 卻在 T-526／T-528／T-530／T-532／T-537 寫「不與其他票同時跑」；crm-system MAP 記載平行時瞬時假紅、基準快照被覆寫。
  - P11：crm-system `MAP.md` 在 019 當時 70KB／333 行，現為 209KB／528 行、113,977 字元，地雷 191 條、最長一成超過 770 字；line工具 `CONTEXT.md` 約 29 萬字元、開頭是版本註記；transcript 統計 line工具 subagent 讀 CONTEXT 385 次、crm-system subagent 讀 MAP 162 次（多為分段讀）。
  - P12：022④ 核准彈窗（母本 transcript 6c561432）推薦說明為「把現場已在做的寫成規則」，舉 AI_project_hub 輪次史五條「流程外，無票」為例；那五條全超過 3 檔，其中「接案流程入口修補」動了 migration 0177／0178、標註「無出貨審查（流程外小修）」。
  - 017⑤：transcript 18 次哨兵注入中 17 次發生在「共 0 張票」；AI_project_hub 的定稿記錄命名為 design-freeze／ui-design-frozen，舊觸發條件在該專案永不成立。
  - 020 更正：由 Workflow 派出的 subagent 讀自身環境變數，`CLAUDE_CODE_SESSION_ID` 與主 session 相同、另帶 `CLAUDE_CODE_CHILD_SESSION=1`；https://code.claude.com/docs/en/hooks 以 `agent_id` 區分 subagent；`serve.mjs` 的 `findRoot` 從 cwd 往上找第一個含 `.constellation/` 的目錄。Codex：https://learn.chatgpt.com/docs/hooks（developers.openai.com/codex/hooks 轉址至此）原文「SessionEnd and Interrupt use 1 second by default and support up to 3 seconds」「SessionEnd hooks always run synchronously, even when async is true」；本機 codex-cli 0.155.1 每次啟動印「clamping SessionEnd hook timeout to 3s」；`serve.mjs` 自記全機進程快照最快 5.7 秒、中位 8.0 秒。
