# Constellation 母本專案詞彙

> 完整定義在 `DESIGN.md`（憲法，修訂須經使用者）；本檔只收讀懂這個 repo 最需要的詞。

- **母本／應用專案**：母本＝本 repo（skill、閘門、install 的唯一源碼）；應用專案＝套用 Constellation 工作流的其他專案（各自有 `.constellation/`）。母本以 junction 掛到 `~/.claude/skills/`、`~/.codex/skills/`、`~/.agents/skills/`，改母本即時生效。
- **閘門五件組**：①git 守門 ②commit 守門 ③session 開場注入 ④驗證 runner ⑤關票刷卡機——全在 `gates/*.mjs`，hook 觸發、平時零開銷。
- **工作軌／知識軌**：`.constellation/` 的兩軌——工作軌＝tickets/（隨輪歸檔）；知識軌＝CONTEXT.md＋decisions/＋HISTORY.md（跨輪累積、不歸檔）。
- **端上桌**：知識軌內容由閘門 3 在 session 開場自動注入，不是寫給人翻的死檔案；「寫了沒端上桌」是 2026-08-04 接續力升級前的病灶。
- **拍板即落檔**：使用者做了取捨型拍板（任何階段）就即時寫 `decisions/NNN-slug.md`（背景＋決定＋原因＋證據）；純事實與實作小事不落，防流水帳。
- **書擋**：ship 全量驗證的節奏——紅燈後全量只當頭尾兩次（拿清單、拿正式證據），修復期間用秒級單點迴圈。
- **縮圈**：票級驗證用票內「驗證指令」清單取代 config 全量，把票級成本鎖在該票影響面；ship 不縮圈。
- **單向門**：design 定稿轉譯完成後，專案元件 code 是唯一真相，`.dc.html` 降為參考資料、不回頭同步。
- **效率鐵則／最低層原則**：verification-playbook「真鏈路也要快」那六條——測試寫在最低可驗層、本地同引擎庫＝真依賴、少往返批次寫法、執行平行度拉滿；對付「ship 全量隨專案膨脹」的寫測試當下紀律。
- **審查定錨**：ship Standards 軸只審「HISTORY.md 上次被 commit 的 commit」之後的 diff——審查成本與專案年齡解耦；基準自動取得、零人工維護（同地圖過期基準手法）。
- **寬改動三段式（expand–contract）**：爆炸半徑跨大半 repo 的機械改動走 expand（並存）→ migrate（分批遷移）→ contract（刪舊），不硬套垂直切片；細節在 phase-weave.md。
