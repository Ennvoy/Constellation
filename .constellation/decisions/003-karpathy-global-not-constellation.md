# 003 Karpathy 四原則寫入全域 CLAUDE.md，不進 Constellation 條文

背景：使用者提出 Karpathy 四原則（Think Before Coding／Simplicity First／Surgical Changes＋極簡清理／Goal-Driven Execution）要求加入 Constellation；盤點後呈交三案（內嵌 phase-build／獨立參考檔／只進 DESIGN.md）請使用者拍板落點。

決定：Constellation 任何條文（DESIGN.md、phase-*.md）都不動，四原則原文寫入使用者全域 `~/.claude/CLAUDE.md` 自成一節，對所有專案、所有工作流生效（含 Constellation 的 build／ship／design 動 code 時）。

原因：全域 CLAUDE.md 由 runtime 每場 session 原生注入，覆蓋面比任何 phase 檔更廣、送達也比導航式讀檔更穩（無 DESIGN.md §11.5「靠指令引導讀檔」的遵從風險）；四原則是通用開發紀律而非 Constellation 專屬機制，放全域即全流程受益，流程檔零改動、零重複維護。

證據：2026-08-04 彈窗「四原則要用哪種落點加入 Constellation？」使用者自由作答「算了你幫我寫到全域claude.md好了」。當時依據：無實測數據，屬覆蓋面與送達穩定性的判斷。
