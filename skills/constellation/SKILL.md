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
| ② UI 定稿 | design | 設計基底同步上 Claude Design → 它自己設計 → canvas 調到滿意 → 拉回 repo 一次性轉譯落地 |
| ③ 合成拆票 | weave | 不再發問，把決議合成任務卡＋垂直拆票（驗收條件、檔案界線） |
| ④ 逐票實作 | build | 無依賴票平行 fan-out、序列整合，每票測試先行→實作→實跑驗證→關票 |
| ⑤ 出貨 | ship | 全量真鏈路驗證＋獨立兩軸審查（Standards／Spec 分開報告） |

## Step 0：偵測現況（純檔案存在性判斷，狀態進檔案不靠對話記憶）

若本次 session 開場已由 session-start 閘門（gate 3）注入 `.constellation/` 現況摘要，直接沿用其結論、跳過重新掃描。否則依序自行檢查：

1. **cwd 下沒有 `.constellation/`** → 全新任務，尚無任何決議。
   Lazy Read `references/phase-grill.md`，從頭開始訪談。

2. **`.constellation/` 存在，但 `tickets/` 不存在或裡面沒有任何 `*.md`**：
   - `decisions/grill-close.md` 不存在 → 訪談尚未完成——**即使 `CONTEXT.md` 或 `decisions/` 底下已經有其他內容也一樣**，這份固定決議檔是唯一的機讀完成標記，沒有它一律判定訪談中途中斷、尚未拍板，不能拿其他檔案有內容來腦補「應該問得差不多了」。
     Lazy Read `references/phase-grill.md`，走增量重訪（機制會自動判斷從哪接，不會重問已拍板的節點）。
   - `decisions/grill-close.md` 存在（內容為大小流程、是否需要 UI、高風險標記、必備模組排除、一句話任務摘要五欄）→ 訪談已完成、尚未拆票。
     Lazy Read `references/phase-weave.md`；若該任務需要 UI 定稿而尚未定稿，weave 會據此轉交
     `references/phase-design.md`，照它接手即可，不必在此另行判斷。

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
       - 先檢查 `.constellation/ship-evidence.md` 存不存在，或 `.constellation/archive/` 底下有沒有已經歸檔的資料夾——任一成立，代表本輪已經出貨過（可能出貨後歸檔步驟還沒跑完、票檔還沒被清走，也可能已經跑完歸檔但這批票是舊資料殘留）。向使用者報告「本輪已出貨」，新需求視為全新任務，Lazy Read `references/phase-grill.md` 從頭訪談，不要誤判成「還要準備出貨」而卡在原地重跑一次 ship；順手補跑一次 `references/phase-ship.md` 步驟 3 把這批舊票歸檔清乾淨即可，不必因為要先歸檔而卡住不開始新訪談。
       - 兩者都不存在 → 向使用者報告全數完成。
         Lazy Read `references/phase-ship.md`，準備出貨。

## 紀律

- 一次只 Read 對應目前狀態的那一份 `references/phase-*.md`；不得因為「反正都要用」而預先讀其餘四份。
- 判斷完全依賴 `.constellation/` 目錄下的檔案內容，不依賴這次對話之前聊過什麼——換一個全新 session 進來，讀檔結果必須一樣。
- 大小分岔（大流程完整走②③④⑤；小流程只在③不拆多票、weave 直接產單一任務卡，之後走輕量⑤）由 `references/phase-grill.md` 在訪談收尾時與使用者一次拍板，本檔不重複判斷。是否需要②（UI 定稿）與大小流程正交、分開決定——不是「小流程＝連②也跳過」。
- 若讀到的現況互相矛盾（例如 `tickets/` 有檔但 `CONTEXT.md` 不存在），照實告知使用者看到的落差，不自行腦補跳過。
- **runtime 降級對照**（此對照放總控，是因為 lazy loading 下 Codex 在後期階段讀不到 `phase-grill.md` 裡的降級說明；各 `references/phase-*.md` 提到下列三個工具時，Codex 端一律按此對照執行，紀律不變、形式退化。**前兩條是按 runtime 分的；第三條不是**——那條看的是工具此刻在不在，兩邊都可能用不上，見該條說明）：
  - **AskUserQuestion 彈窗**（Claude Code 端所有提問——開放問題與封閉確認——都走彈窗，一次一題）→ Codex 端沒有這個工具，一律降級為純文字點列格式：一則訊息一題、置於結尾醒目處、推薦排第一並標記；使用者可回數字、回「ok」、或打自由文字。
  - **Workflow 工具（票平行 fan-out）** → Codex 端沒有這個工具，這批票改序列逐張做，不平行。
  - **DesignSync／Claude Design canvas** → **判斷依據是「工具此刻在不在、通不通」，不是「跑在哪個 runtime」**：Claude Code 端離線或額度用完一樣用不上，另一邊哪天掛上可用的工具、登入也通了就用得上，所以每次進 design 階段先實際確認一次。確認得出這次用不上時**不默默降級**——先用白話告知使用者落差（含那句誠實話：執行端自己寫幾個版本，那幾版只是同一個判斷的幾種寫法，不等於真的比較過不同方案），再讓他選「換到有這個服務的環境做完這一步」或「不換、由執行端自己寫畫面 code 用文字來回修」。選自己寫時預設先做一版再迭代（不是一次生 3 版），東西本來就在 repo 裡，少了「拉回」與「轉譯」兩步，定稿記錄與凍結照跑。小工程（改一個按鈕／加一個欄位／既有設計語言下的單一元件／bug fix）不必問，直接改 code 給使用者看。細節與「大小工程怎麼分」在 `references/phase-design.md` 的「降級路徑」。**Codex 端另外沒有彈窗**，上面那個「換／不換」的提問比照本對照第一條改成文字點列。
