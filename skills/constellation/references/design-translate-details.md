# .dc.html 轉譯細節（phase-design 步驟 5 的按需細節檔）

> 本檔是 `phase-design.md` 步驟 5 的轉譯對應表、必踩陷阱與成本實測全文。只在真的要動手轉譯時 Read 本檔。

**轉譯對應表**（實測完整轉過一次 347 行的檔案，並對照 dc-runtime 原始碼驗證過）：

| dc 語法 | 對應到 | 難度 |
|---|---|---|
| `{{ expr }}` | JSX 表達式 | 機械（注意 dc 會把文字位置的 `{{ }}` 包一層 `<span class="sc-interp">`，落地時這層會消失，DOM 結構有差） |
| `<sc-if value="{{ c }}">` | 條件渲染 | 機械 |
| `<sc-for list="{{ a }}" as="x">` | `.map()` | 機械（dc 用陣列 index 當 key，落地建議改用穩定 id） |
| `hint-placeholder-*` | 丟棄 | 只在生成串流預覽時有意義，執行期無效 |
| `<helmet>` | 全域 CSS | 機械（裡面那個 `_ds_bundle.js` script 直接丟掉，專案不需要） |
| `class Component extends DCLogic` | `React.Component` | 機械——`state`／`setState`（支援 updater function 與 shallow merge）／`componentDidMount`／`componentWillUnmount` 全部同名同義 |
| `renderVals()` | render 前置運算 | 機械 |
| `data-props` | 元件 props ＋ 預設值 | **部分流失**：`default` 對得上，但 `editor`／`options`／`section`（那是 Claude Design 的 Tweaks 面板 UI）在專案端**沒有任何對應物**；`tsType` 只有輸出 `.tsx` 才救得回來 |
| `style-*` | CSS 偽類 | **前綴通吃**——不只 `style-hover`／`style-focus`，`style-active`／`style-disabled`／`style-focus-within` 都生效，`style-before`／`style-after` 還會走 pseudo-element 分支，**不可以寫死只有兩種**。dc 自己的實作是每條宣告都加 `!important` |
| 靜態 `style="…"` 字串 | `className` | 需要判斷（class 怎麼命名、怎麼分類全靠自己發明，來源檔沒有任何命名資訊） |
| **動態 `style="{{ 拼接字串 }}"`** | class modifier | **★唯一真正機械化不了的**——像 `'background:' + (on ? '#f0e6e1' : 'transparent')`，機器無法判斷哪一段是狀態、哪一段是常數 |

**兩個一定會踩到的陷阱：**

1. **inline style 打敗 CSS**：底色由動態 inline style 決定的元素，`:hover` 會直接失效（inline 永遠贏）。要把底色搬進一個 modifier class（例如 `.is-active`），再讓 `:hover` 規則**排在 modifier 之後**、靠來源順序取勝。dc 自己是靠每條都加 `!important` 無條件贏——落地時若不想用 `!important`，就得自己處理這個 cascade 順序問題。
2. **假資料**：`.dc.html` 裡的 `DATA` 是 Claude Design 編出來的假資料（含假 email、假 IP）。落地時要換成真的 API，並在檔案裡標註清楚哪裡還接著假資料——不要讓假資料悄悄活到出貨。

**成本預期（實測值，據實寫給人有心理準備）**：347 行 `.dc.html` → 467 行 JSX ＋ 492 行 CSS，位元組是原來的 1.36 倍。**邏輯層幾乎零成本**（175 行基本上原封貼上）；時間全花在拆解動態 style 字串（9 處，約佔一半時間）與 class 命名（79 個）。轉譯後行為與視覺零落差。
