# Constellation 母本專案詞彙

> 完整定義在 `DESIGN.md`（憲法，修訂須經使用者）；本檔只收讀懂這個 repo 最需要的詞。

- **母本／應用專案**：母本＝本 repo（skill、閘門、install 的唯一源碼）；應用專案＝套用 Constellation 工作流的其他專案（各自有 `.constellation/`）。母本以 junction 掛到 `~/.claude/skills/`、`~/.codex/skills/`、`~/.agents/skills/`，改母本即時生效。
- **閘門五件組**：①git 守門 ②commit 守門 ③session 開場注入 ④驗證 runner ⑤關票刷卡機——全在 `gates/*.mjs`，hook 觸發、平時零開銷。同目錄的 `clean-artifacts.mjs` 與 `serve.mjs` **是工具不是閘門**（不算第六件）；`serve.mjs` 另掛 SessionEnd hook，session 結束自動收掉本 session 登記的 server。
- **記帳起停**：臨時 server 一律經 `gates/serve.mjs` 起停，`start`／`stop`／SessionEnd 只認登記過的、殺前比對啟動時間，絕不掃全機的埠（避免誤殺使用者自己開的或平行 session 的）；worktree 內的登記獨立、worker 收工前得自己 `stop`，Codex 端 SessionEnd 收不齊也得靠手動收（細節見母本 DESIGN.md §5、`verification-playbook.md`「臨時 server 的起與收」，案例見決議 020／023）。
- **工作軌／知識軌**：`.constellation/` 的兩軌——工作軌＝tickets/（隨輪歸檔）；知識軌＝CONTEXT.md＋decisions/＋HISTORY.md（跨輪累積、不歸檔）。
- **端上桌**：知識軌內容由閘門 3 在 session 開場自動注入，不是寫給人翻的死檔案；「寫了沒端上桌」是接續力升級前的病灶（案例見決議 001）。
- **拍板即落檔**：使用者做了取捨型拍板（任何階段）就即時寫 `decisions/NNN-slug.md`（背景＋決定＋原因＋證據）；純事實與實作小事不落，防流水帳。
- **書擋**：ship 全量驗證的節奏——紅燈後全量只當頭尾兩次（拿清單、拿正式證據），修復期間用秒級單點迴圈。
- **縮圈**：票級驗證用票內「驗證指令」清單取代 config 全量，把票級成本鎖在該票影響面；ship 不縮圈。
- **單向門**：design 定稿轉譯完成後，專案元件 code 是唯一真相，`.dc.html` 降為參考資料、不回頭同步。
- **效率鐵則／最低層原則**：verification-playbook「真鏈路也要快」那六條——測試寫在最低可驗層、本地同引擎庫＝真依賴、少往返批次寫法、執行平行度拉滿；對付「ship 全量隨專案膨脹」的寫測試當下紀律。
- **審查定錨**：ship Standards 軸只審「HISTORY.md 上次被 commit 的 commit」之後的 diff——審查成本與專案年齡解耦；基準自動取得、零人工維護（同地圖過期基準手法）。
- **寬改動三段式（expand–contract）**：爆炸半徑跨大半 repo 的機械改動走 expand（並存）→ migrate（分批遷移）→ contract（刪舊），不硬套垂直切片；細節在 phase-weave.md。
- **預授權**：design 定稿記錄附的「預授權檔案清單」（檔案路徑 → 預計哪張票接真資料），build 階段照清單直接換掉寫死值、接真 API，不必為此另外彈窗解凍——但順序仍是先解凍（路徑移出 `frozen`＋`log` 補 `unfreeze`）再改檔，改完補回 `frozen`＋`log` 補 `refreeze`；閘門 5 編輯當下只看路徑在不在 `frozen`，關票時才驗這對記錄有沒有配上（鎖回）。
- **流程外**：小改動的第三條路——符合 `phase-grill.md`「流程外」條件（一個連貫改動且主線或單一工作流做得完，且不動資料結構、不動權限、不碰凍結名單內檔案）就不進五步主幹，落一筆決議＋commit＋在 `HISTORY.md` 補一行（註明有無獨立審查、全量測試結果）即可。
- **大量資料標記**：高風險第四類（原本只有權限／金流／個資三類），三個訊號任一命中即標——筆數估算超門檻、資料表粒度會隨時間長大、使用者用詞出現「幾千人／名單／匯入／報表／重算／歷史／全站」；標了會讓相關票必寫量級門檻、ship 階段加開效能實測軸。
- **測試整理**：關票前只留每條驗收條件對應的行為測試（期末考題），把實作過程中寫來探路、驗中間邏輯的草稿題清掉，不讓票的測試檔案愈堆愈多。
