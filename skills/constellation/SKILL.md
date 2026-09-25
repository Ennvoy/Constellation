---
name: constellation
description: 當使用者要啟動新功能開發、想走完整開發工作流、要開新專案／處理新需求、要做需求訪談，或明確提到 constellation／星座工作流時啟用。偵測專案 .constellation/ 目錄現況，自動接續五步流程（訪談→UI 定稿→合成拆票→逐票實作→出貨）中對的一步，不必使用者自己判斷該從哪接。單純修 bug、單純問問題、單純看 code 不觸發本技能。
---

# Constellation 總控

本檔只做一件事：**偵測現況、決定接到哪一步、Read 對應的 phase 參考檔照做**。所有實作規則都在
`references/phase-*.md`，本檔不重複——一次只 Read 當下用得到的那一份，其餘四份不預先載入。

## 五步主幹（一行一步）

| 步驟 | 代號 | 一句話 |
|---|---|---|
| ① 訪談 | grill | 批次問到 frontier 清空，決議即時落檔 |
| ② UI 定稿 | design | Claude Design 自己設計（或執行端自己寫）→ **直接改專案正式頁面 code** → **執行端在本地逐一點過、整頁截圖交使用者看圖拍板**（缺工具時退回使用者自己點）→ 才算定稿（真數字／後端後接）|
| ③ 合成拆票 | weave | 不再發問，把決議合成任務卡＋垂直拆票（驗收條件、依賴關係） |
| ④ 逐票實作 | build | 無依賴票平行 fan-out、序列整合，每票測試先行→實作→實跑驗證→關票 |
| ⑤ 出貨 | ship | 全量真鏈路驗證＋獨立各軸審查（Standards／Spec 分開報告） |

## Step 0：偵測現況（純檔案存在性判斷，狀態進檔案不靠對話記憶）

`.constellation/next-round/` 不屬於本輪，以下判斷都不看它——那裡放的是留給下一輪的待辦票，不管有沒有票、幾張，都不影響現在該接到訪談、拆票、實作還是出貨哪一步。

依序自行檢查：

1. **cwd 下沒有 `.constellation/`** → 全新任務，尚無任何決議。
   Lazy Read `references/phase-grill.md`，從頭開始訪談。

2. **`.constellation/` 存在，但 `tickets/` 不存在或裡面沒有任何 `*.md`**：
   - `decisions/grill-close.md` 不存在 → 訪談尚未完成——**即使 `CONTEXT.md` 或 `decisions/` 底下已經有其他內容也一樣**，這份固定決議檔是唯一的機讀完成標記，沒有它一律判定訪談未完成，不能拿其他檔案有內容來腦補「應該問得差不多了」（`decisions/` 有內容不代表訪談開過：「拍板即落檔」通則下，流程外的平時討論也會合法落 decisions/——那些是既有決議背景，不是訪談進度）。
     Lazy Read `references/phase-grill.md`，走增量重訪（機制會自動判斷從哪接，不會重問已拍板的節點）。
   - `decisions/grill-close.md` 存在、記著大流程，但檔尾沒有「盲點審：已收斂（第 N 輪）」這一行（使用者喊停時寫成「盲點審：使用者喊停（第 N 輪）」，效力相同）→ 訪談收尾已拍板，但獨立盲點審還沒跑完（例如跑到一半換了 session）。不得因為看到 grill-close.md 就當盲點審已經跑完：Lazy Read `references/phase-grill.md`，照「完整性四保險」第 3 點接回盲點審；需要 UI 時畫面製作可同時接續，但 5b 看圖拍板前要收斂。
   - `decisions/grill-close.md` 存在（內容為大小流程、是否需要 UI、高風險標記、必備模組排除、一句話任務摘要五欄；大流程檔尾另有盲點審收斂那一行；`next-round/` 有票且這輪對它們有任何決定時，檔尾另有「下輪待辦」那一行）→ 訪談已完成、尚未拆票。
     Lazy Read `references/phase-weave.md`；若該任務需要 UI 定稿而尚未定稿，weave 會據此轉交
     `references/phase-design.md`，照它接手即可，不必在此另行判斷。
     ⚠ **「已定稿」不是看有沒有那筆定稿決議就算**——weave 進場要過機器三驗（定稿記錄含逐區塊元件清單與拍板紀錄，記錄裡會註明走的是哪一種：Artifact 連結＋逐互動結果，或使用者拍板回覆原文／`design-frozen.json` 的 `frozen` 非空／名單每個路徑真的存在於 repo），任一條不成立就是沒定稿、要退回 design 補做。這三條純檔案檢查、兩個 runtime 都一樣，細節在 `references/phase-weave.md` 進場條件。

3. **`tickets/` 底下有 `*.md`**：
   - 先讀 `.constellation/config.json` 有沒有 `"approved": true`：**沒有**（欄位不存在或為 `false`）→ 代表這批票是 weave 合成出來的，但使用者核准確認那一步被中斷、還沒走完（機讀核准標記見 DESIGN.md §4）。向使用者說明目前看到的票清單摘要，Lazy Read `references/phase-weave.md`，回到「完成後：呈交票清單摘要」那一步重新請使用者核准確認，不能跳過核准直接當作已進 build。
   - **有** `"approved": true` → 照票的 `status:` 欄位判斷：
     - 任一票 `status: open` 或 `in-progress` → 向使用者報告現況：列出每張票的名稱與狀態，
       in-progress 的票額外摘要做到哪（讀該票「決議記錄」段落）。
       Lazy Read `references/phase-build.md`，接續實作。
     - 沒有 `open`／`in-progress`，但有票 `status: blocked` → 向使用者報告被什麼卡住
       （讀該票「決議記錄」找卡住原因；`blocked-by` 欄位空著代表卡在大事待決或真依賴未就緒——原因見決議記錄，不是在等別張票；`blocked-by` 有填票號才是卡在依賴鏈，等那張票 `done` 才會解除）。
       Lazy Read `references/phase-build.md`，照其 blocked 彙整規則處理（大事分歧統一彙報、彈窗請使用者拍板）。
     - 全部票 `status: done`：
       - 讀 `.constellation/ship-report.md`：**存在**、且它「做了什麼」段落第一行列出的票號**涵蓋現行 `tickets/` 底下全部票** → 代表本輪已經出貨過。向使用者報告「本輪已出貨」，新需求視為全新任務；順手補跑一次 `references/phase-ship.md` 步驟 3 把這批舊票歸檔清乾淨，歸檔完成後 Lazy Read `references/phase-grill.md` 從頭訪談，不要誤判成「還要準備出貨」而卡在原地重跑一次 ship。
       - 否則（檔案不存在，或票號沒涵蓋現行全部票）→ 向使用者報告全數完成，Lazy Read `references/phase-ship.md`，準備出貨——若上輪出貨在中途被中斷，從還沒做完的那個 ship 步驟接續，不重跑已經做完的部份。

## 紀律

- 一次只 Read 對應目前狀態的那一份 `references/phase-*.md`；不得因為「反正都要用」而預先讀其餘四份。
- 判斷完全依賴 `.constellation/` 目錄下的檔案內容，不依賴這次對話之前聊過什麼——換一個全新 session 進來，讀檔結果必須一樣。
- 大小分岔（大流程完整走②③④⑤；小流程只在③不拆多票、weave 直接產單一任務卡，之後走輕量⑤）由 `references/phase-grill.md` 在訪談收尾時與使用者一次拍板，本檔不重複判斷。是否需要②（UI 定稿）與大小流程正交、分開決定——不是「小流程＝連②也跳過」。
- 若讀到的現況互相矛盾（例如 `tickets/` 有檔但 `CONTEXT.md` 不存在），照實告知使用者看到的落差，不自行腦補跳過。`tickets/` 有票卻沒有 `decisions/grill-close.md` 也算這種矛盾（這批票沒經過訪談收尾）——例外：出貨歸檔做到一半（`ship-report.md` 已涵蓋現行全部票，照 Step 0 第 3 點補跑歸檔即可）。這句攔不住刻意繞過流程直接開票（例如正式站出事時的緊急作戰，案例見決議 024），只擋無心漏掉的訪談收尾。
- **開發中或出貨時說「下一輪再做」的事，一律開成票放進 `.constellation/next-round/`，不另列候選清單**——不管是 build 期彈窗使用者選了「記進下一輪候選」、還是 ship 審查發現的建議級待辦，都用這個固定收件點；不要就地寫成一段文字清單留在票面、決議或報告裡，那種清單會跟著它所在的檔案一起被歸檔，下一輪看不到（案例見決議 027）。
- **拍板即落檔（不分階段的通則）**：任何階段——訪談、實作、出貨、乃至流程外的平時討論——只要使用者做了**取捨型拍板**（彈窗選了方向、文字明確拍板），就即時寫一筆 `.constellation/decisions/NNN-slug.md`：背景＋決定＋原因＋證據各 1–2 句，證據記拍板脈絡（彈窗題目與所選選項原文，或使用者原話一句）與當時依據（實測數據、文件連結；沒有就寫「無」）。純事實（查得到的）與實作小事（記入票的決議記錄）不落 decisions/，防流水帳。落了檔，下個 session 開場注入就會端上桌——「討論好的決議隔天就忘」正是靠這條根治，不落檔等於白討論。
- **等別人時，背景要有東西會自己結束並叫醒你**：結束回合前若在等另一個 session（機器被佔用、對方全量還沒跑完），背景必須有一個會自己結束並主動叫醒你的東西——排隊中的驗證 runner（見 `references/phase-ship.md` 步驟 1）是最常見的一種，其餘背景任務比照辦理；正文寫明是靠哪一個叫醒、最晚幾點該回報。**沉默不算同意，閒置不算做完**——不得只寫「等對方通知」就把回合結束掉。
- **流程外小改動**：符合 `phase-grill.md`「流程外」條件的改動不進五步主幹——落一筆決議＋直接改＋commit，在 `.constellation/HISTORY.md` 最上方補一行「`## <日期> <摘要>（流程外，無票）獨立審查：<有/無>；全量測試：<結果>`」即可，不寫 `grill-close.md`、不建 archive。改動主體是給人讀的產出（週報、推播、報表文字、口徑數字）且改的是呈現方式或口徑時，盡量在動工前用拋棄式腳本套真資料做一份樣本給使用者看一次、最晚在審查與上線前（細節見 `phase-grill.md`「訪談收尾」）。本檔 Step 0 讀到 `HISTORY.md` 裡 `##` 開頭、內含「（流程外，無票）」的行，不當成未歸檔的輪次——那本來就沒有票、不必也不會有票清單可歸。這輪若同時放棄了 `next-round/` 裡的某張票、或那張票剛好被這次流程外改動順手解決掉，同一個 commit 裡把它 `git mv` 到 `.constellation/archive/next-round-closed/`，落的那筆決議寫明原因（放棄或已被這次改動解決）——不寫這一步，下一輪還是會再被問到那張票，甚至被重做。
- **runtime 降級對照**（此對照放總控，是因為 lazy loading 下 Codex 在後期階段讀不到 `phase-grill.md` 裡的降級說明；各 `references/phase-*.md` 提到下列工具時，Codex 端一律按此對照執行，紀律不變、形式退化）：
  - **AskUserQuestion 彈窗**（Claude Code 端所有提問——開放問題與封閉確認——都走彈窗，一次一題）→ Codex 端沒有這個工具，一律降級為純文字點列格式：一則訊息一題、置於結尾醒目處、推薦排第一並標記；使用者可回數字、回「ok」、或打自由文字。
  - **Workflow 工具（票平行 fan-out）** → Codex 端沒有這個工具，這批票改序列逐張做，不平行。
  - **DesignSync／Claude Design canvas、瀏覽器工具與 Artifact**（②畫面定稿整套判準與降級）→ 不重複列在這裡，寫在 `references/phase-design.md`；判準是「工具此刻在不在」，不是按 runtime 分。
  - **SessionEnd 自動收臨時 server** → Codex 端上限 3 秒，`reap` 常收不完（不殺也不刪登記），得靠 `serve.mjs stop --port <p>` 手動收；細節見本檔同目錄 `references/verification-playbook.md`「臨時 server 的起與收」，這裡不重複。
