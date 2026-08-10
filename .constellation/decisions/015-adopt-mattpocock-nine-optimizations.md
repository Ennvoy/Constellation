# 015 採納 mattpocock/skills 借鑑優化九項、否決 wizard 一項

背景：使用者要求全文讀完 mattpocock/skills 的 engineering 全部 17 個 skill（含 grilling／writing-for-agents 等核心依賴），對照 Constellation 憲法、五 phase 條文與決議 001–014 找優化點；產出十項提案（A–J）白話版文件後逐組彈窗拍板。

決定：採納九項——A 出貨 Standards 軸鎖定本輪 diff（以「HISTORY.md 上次被 commit 的 commit」當零維護基準，開審前先驗 ref 與 diff 非空）；B Fowler 12 smells 固定清單入條文＋三規則（repo 規範壓過 baseline／工具已強制的不重複報／一律 judgement call）＋每軸報告 400 字上限；C 寬改動 expand–contract 三段式拆票（新舊並存→分批遷移→刪舊）；D phase-design.md 依 progressive disclosure 拆瘦（DesignSync 細節與轉譯表拆成按需載入的細節檔）；E 訪談邏輯原型繞道（狀態機／資料模型談不攏時產單檔 HTML 拋棄式樣品玩過再拍板，閱後即焚不進 repo）；F 詞彙挑戰紀律（用詞與 CONTEXT.md 衝突當場點破）；G 落檔證據遮密（金鑰／token／個資一律 `<REDACTED>`、指令用環境變數引用，遮值不遮形）；H 除錯迴圈補兩式（迴圈收緊三問＋非確定性 bug 先拉高重現率）；J 拆票前置重構通則（先讓改動變容易，再做容易的改動；沒有就不硬找）。否決一項——I 人類專屬步驟精靈（wizard 帶路小工具）。

原因：九項皆條文級改動、零閘門程式碼、零常駐開銷，各對應實存缺口（審查成本隨專案年齡線性成長、寬改動讓 zone 平行癱瘓、38.5KB 規則檔全讀、對想像拍板的返工、證據落檔金鑰進 git 等）；I 的使用頻率不明，規則檔白放著違反 §0「機制省下的時間須超過消耗的時間」。

證據：拍板脈絡＝2026-08-10 四次彈窗——「出貨檢查」選 A＋B、「拆票實作」選 C＋J（I 未選）、「訪談強化」選 E＋F、「文件證據」選 D＋G＋H。當時依據＝mattpocock/skills 全讀比對報告（artifact 0b07f8cf-e9b8-4602-bb5f-03fb776adb80）；phase-design.md 實測 38,492 bytes；phase-ship.md Standards 軸現行條文無審查範圍定義之檢視。
