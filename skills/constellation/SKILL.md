---
name: constellation
description: 當使用者要開發新功能、啟動或推進一個專案、想跑開發工作流、要做需求訪談、有開發任務要處理，或提到 constellation／星座工作流時啟用。偵測專案 .constellation/ 目錄現況，自動接續五步流程（訪談→UI 定稿→合成拆票→逐票實作→出貨）中對的一步，不必使用者自己判斷該從哪接。
---

# Constellation 總控

本檔只做一件事：**偵測現況、決定接到哪一步、Read 對應的 phase 參考檔照做**。所有實作規則都在
`references/phase-*.md`，本檔不重複——一次只 Read 當下用得到的那一份，其餘四份不預先載入。

## 五步主幹（一行一步）

| 步驟 | 代號 | 一句話 |
|---|---|---|
| ① 訪談 | grill | 批次問到 frontier 清空，決議即時落檔 |
| ② UI 定稿 | design | 生成多變體真元件 → canvas 挑選微調 → 定稿即最終品，不重畫 |
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
   - `decisions/grill-close.md` 存在（內容為大小流程選擇＋是否需要 UI＋一句話任務摘要）→ 訪談已完成、尚未拆票。
     Lazy Read `references/phase-weave.md`；若該任務需要 UI 定稿而尚未定稿，weave 會據此轉交
     `references/phase-design.md`，照它接手即可，不必在此另行判斷。

3. **`tickets/` 底下有 `*.md`**，逐檔讀 `status:` 欄位：
   - 任一票 `status: open` 或 `in-progress` → 向使用者報告現況：列出每張票的名稱與狀態，
     in-progress 的票額外摘要做到哪（讀該票「決議記錄」段落）。
     Lazy Read `references/phase-build.md`，接續實作。
   - 沒有 `open`／`in-progress`，但有票 `status: blocked` → 向使用者報告被什麼卡住
     （讀該票「決議記錄」找卡住原因；`blocked-by` 欄位空著代表卡在大事待決或真依賴未就緒——原因見決議記錄，不是在等別張票；`blocked-by` 有填票號才是卡在依賴鏈，等那張票 `done` 才會解除）。
     Lazy Read `references/phase-build.md`，照其 blocked 彙整規則處理（大事分歧統一彙報、彈窗請使用者拍板）。
   - 全部票 `status: done` → 向使用者報告全數完成。
     Lazy Read `references/phase-ship.md`，準備出貨。

## 紀律

- 一次只 Read 對應目前狀態的那一份 `references/phase-*.md`；不得因為「反正都要用」而預先讀其餘四份。
- 判斷完全依賴 `.constellation/` 目錄下的檔案內容，不依賴這次對話之前聊過什麼——換一個全新 session 進來，讀檔結果必須一樣。
- 大小分岔（大流程完整走②③④⑤；小流程只在③不拆多票、weave 直接產單一任務卡，之後走輕量⑤）由 `references/phase-grill.md` 在訪談收尾時與使用者一次拍板，本檔不重複判斷。是否需要②（UI 定稿）與大小流程正交、分開決定——不是「小流程＝連②也跳過」。
- 若讀到的現況互相矛盾（例如 `tickets/` 有檔但 `CONTEXT.md` 不存在），照實告知使用者看到的落差，不自行腦補跳過。
