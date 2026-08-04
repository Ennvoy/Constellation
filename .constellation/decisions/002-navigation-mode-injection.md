# 002 開場注入一律導航模式（否決全文注入與截斷式）

背景：001 的「知識軌全文注入」上線後 headless 實測，發現 Claude Code 對 hook 注入有 10,000 字元硬門檻——超線整包被持久化成外部檔案、開場只剩 2KB 預覽；「活動計算」專案（9,600+ 字元）實際撞線，「開場即知情」在大專案不成立。

決定：閘門 3 一律走導航模式——置頂【開工前必讀】強制讀檔指令＋票況＋HISTORY 最近輪次＋decisions/ 標題索引＋CONTEXT.md 詞條名清單，知識內文不注入；另設 9,000 字元 failsafe 硬截。不採兩檔位自適應（塞得下才全文）、不採截斷式。

原因：知識軌單調成長，任何活躍專案遲早撞線——「塞得下」只是快照不是趨勢；截斷式會越截越多且給模型「已拿到全文」的假象；單一形狀行為一致好預測，索引量與專案規模解耦、永不撞線。

證據：使用者原話「可是你現在不就被擋住了嗎，這個專案甚至沒有怎麼開發」（指出成長性問題）；2026-08-04 彈窗「注入策略要選哪個？」在「兩檔位自適應（推薦）」與「一律導航模式」中選了後者。當時依據：官方 hooks 文件「Hook output strings, including additionalContext, are capped at 10,000 characters. Output that exceeds this limit is saved to a file and replaced with a preview and file path.」；活動計算注入 28.8KB 被持久化的 headless 實測。
