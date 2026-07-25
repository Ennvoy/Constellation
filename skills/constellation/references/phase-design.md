# Phase ② UI 定稿（design）

一句話：生成幾個結構真的不同的真元件變體 → push 上 canvas 讓使用者挑選微調 → 定稿 pull 回來就是最終品，不重畫。

解決的根本問題是 mockup 與成品不符（出處：母本 DESIGN.md §3，部署後 runtime 不需讀取）——這裡定稿的是**真元件真 code**，不是給人看一眼就丟的圖。

## 進場 / 離場

- **進場條件**：本檔同目錄的 `phase-grill.md` 收尾時判定這次任務**需要 UI**（不是純後端／無 UI 任務），frontier 已清空、使用者已拍板。
- **離場條件**：使用者已經在 canvas（或降級路徑的本地變體走查）挑定並微調出最終版本、pull 回 repo、變體 scaffold 清乾淨只留定稿版本 → 交給本檔同目錄的 `phase-weave.md`。
- **無 UI 任務**：本檔同目錄的 `phase-grill.md` 判定不需要 UI 時，本階段完全不運行，repo 裡也不會出現任何變體或 canvas 相關檔案，直接由 grill 交給 weave。

## 步驟 1：挑基底設計系統

- 三個變體共用**同一個**品牌基底（一起換掉配色會讓「哪個結構好」被「哪個配色好」污染，比較不出真正的差異）。
- 若 `CONTEXT.md`／`decisions/` 裡訪談階段已經記錄使用者的風格偏好，直接沿用，不重問。
- 沒有既定偏好：先 lazy 讀同目錄 `design-systems/index.md`（只讀索引，不把 150 套內容整份塞進 context），依這次任務的調性／受眾抓 2–3 個候選，套用本檔同目錄的 `phase-grill.md` 的開放問題格式問使用者選（這是有取捨的真決策，不是事實，不用彈窗）：每個候選附一句「適合什麼調性」。
- 選定後，只 lazy 讀那一套的 `design-systems/<slug>/DESIGN.md`（9 段規範）＋ `tokens.css`（CSS 變數），其餘 149 套不讀。三個變體都從這份 tokens 出發做客製化延伸，不是套用預設樣式了事。

## 步驟 2：生成 3 個結構不同的變體（上限 5）

- **結構不同**指資訊架構／導覽模式／互動流程本身不同，不是換個顏色或字體交差。例如同一個功能可以是：卡片網格總覽、側邊欄列表＋詳情面板、逐步式精靈（wizard）——三種使用者要點幾下、資訊怎麼分層看到的方式都不一樣。
- 每個變體都是**真元件真 code**（能跑、能點），不是靜態圖或截圖。
- **優先掛在既有頁面**，用 `?variant=` 參數切換到不同結構（例如 `?variant=a`／`?variant=b`／`?variant=c`）——因為空白路由是真空環境，脫離真實使用情境的頁面會讓每個變體都顯得好看，比較不出在實際脈絡下的優劣。
- 這個功能沒有對應的既有頁面（全新功能／全新頁面）才退而求其次開一個新路由，一樣用 `?variant=` 切換。
- `?variant=` 切換器本身是**暫時腳手架**，只為了這個階段的比較用；定稿後會被清掉（見步驟 4），正式 code 不會留著三份變體共存或一個切換開關。

## 步驟 3：push 上 canvas（DesignSync）

用 DesignSync 工具把變體送上 Claude Design canvas：

1. `list_projects` 找這個專案既有的 design-system project；沒有就 `create_project` 新建一個。
2. `finalize_plan`：`writes` 列出這三個變體 preview 檔會寫進 canvas 專案的路徑，`localDir` 指向 repo 裡放這些變體的目錄。
3. `write_files` 把變體檔案傳上去。每個 preview 檔案第一行加 `<!-- @dsCard group="..." -->` 標記，canvas 會自動依此建卡片索引，不必額外呼叫 `register_assets`（那是給沒有這個標記的手寫舊專案用的）。
4. 提示使用者去 Claude Design 開這個專案，在 canvas 上視覺化比較三個變體、點選、手動微調。
5. 使用者調完後，用 `list_files`／`get_file` 把最終版本 pull 回本地——這份 pull 回來的內容就是正式定稿，不再是某個 `variant=N`。

## 步驟 4：定稿即最終品，清乾淨腳手架

- 把 pull 回來的定稿內容寫回正式元件／正式路由，移除 `?variant=` 切換器與其餘沒被選中的變體檔案——收尾時 repo 裡只留一份正式版本，沒有殘留的變體開關或死檔案。
- 收尾寫一筆 `decisions/NNN-slug.md`：記錄用了哪個品牌基底、比較過哪幾種結構、使用者選了哪個、微調了什麼重點。這筆記錄就是 `ticket-template.md`「目標」段落唯一例外提到的「design canvas 定稿記錄」的來源——後續票要引用定稿視覺／互動細節時，指到這筆決議即可。
- **定稿即凍結**（出處：母本 DESIGN.md §3 第 4 點，部署後 runtime 不需讀取）：上面清乾淨腳手架後，把全部定稿元件的檔案路徑（repo 相對路徑）寫入 `.constellation/design-frozen.json` 的 `frozen` 陣列，並在同檔的 `log` 陣列裡逐一補一筆：
  ```json
  { "path": "src/components/LoginForm.tsx", "action": "freeze", "at": "<ISO 時間戳>", "reason": "design 定稿" }
  ```
  `.constellation/design-frozen.json` 不存在就直接新建（`frozen` 與 `log` 兩個陣列都要有）。**從這一刻起，這些檔案受閘門 5（關票刷卡機）凍結保護**——實作期（build）任何工具想編輯這些檔案都會被機器擋下，不能悄悄改掉使用者已經看過拍板的畫面。
- **定稿後 UI 不再重畫**：後續拆出的每張票都對著這份定稿開發，不能因為某張票有新想法就重新生成一輪變體比較。build 階段若發現定稿漏了某個狀態（例如錯誤訊息、loading、空狀態）——沿用定稿的視覺語言把那個狀態補上，算票內部的「小事」，不用回頭重跑本階段；只有發現定稿的**整體結構方向**本身有問題（不是漏了一個狀態，是整個資訊架構要換），才算「大事」（出處：母本 DESIGN.md §8，部署後 runtime 不需讀取），停下彈窗問使用者要不要回頭重跑一次本階段。

## 降級路徑：DesignSync 不可用

DesignSync／canvas 不可用（離線、額度不足、Codex runtime 本來就沒有這個工具——降級表出處：母本 DESIGN.md §9，部署後 runtime 不需讀取）時，退化為**純本地變體走查**，流程其餘不變：

1. 跳過步驟 3 的 push／pull，直接在瀏覽器開 `?variant=a`／`b`／`c`（或各自的新路由）逐一走查。
2. 使用者直接用文字講「要哪個、想改哪裡」，agent 依文字回饋改那個變體的 code，反覆調整到使用者滿意。
3. 滿意即定稿——不需要額外的 pull 動作（本來就在 repo 裡），比照步驟 4 清掉其餘變體與切換器，只留這一份成為正式元件，並一樣寫 `decisions/NNN-slug.md` 定稿記錄。
- 「是否滿意、是否還要再調」這類封閉確認，Claude Code 端用 AskUserQuestion 彈窗；Codex 端本來就沒有彈窗，比照本檔同目錄的 `phase-grill.md` 的 Codex 降級規則改用文字點列確認。
