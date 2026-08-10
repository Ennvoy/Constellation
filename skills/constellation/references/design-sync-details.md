# DesignSync 推檔細節（phase-design 步驟 1 的按需細節檔）

> 本檔是 `phase-design.md` 步驟 1c–1f 的全文細節——app 端只認特定檔案形狀，形狀不對不會報錯、只會完全隱形。以下每一條都是實測反編譯拿到的字面規則，不是慣例猜測。只在真的要動手推檔時 Read 本檔。

### 1c. 檔案要長什麼形狀（app 端只認這個形狀）

以下每一條都是實測反編譯 app 端自檢邏輯拿到的**字面規則**，不是慣例猜測。形狀不對的檔案不會壞掉，只會**完全隱形**——這是本階段最容易白做的地方。

**① 根目錄放唯一的樣式入口 `styles.css`**，用 `@import` 串起其餘 CSS：

```css
@import url("https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;600&display=swap");
@import "./tokens.css";
@import "./theme.css";
@import "./global.css";
@import "./components.css";
```

- 入口檔名的優先序：`styles.css` → `index.css` → `global.css` → `globals.css` → `main.css` → `theme.css` → `tokens.css`，**只取第一個命中的，而且只認根目錄**（放在子目錄一律不認）。
- **沒有被這條 `@import` 鏈碰到的 CSS 檔完全隱形**，寫了等於沒寫。
- 遠端 `@import`（例如 Google Fonts）沒問題，它會被餵給 manifest 的 `brandFonts`，不會弄壞這條鏈。

**② `tokens.css`：所有設計變數宣告在 `:root` 底下。**

- 宣告在元件類選擇器底下的自訂屬性**會被丟掉**，只有 `:root` 算。
- **坑**：`--color-text` 會被判成字型類（`kind: "font"`）——因為 font 的比對規則含 `text` 且排在 color 前面。修法是在**同一行的分號後面**加註標：

  ```css
  :root {
    --color-text: #1a1a1a; /* @kind color */
  }
  ```

  註標**必須貼在同一行分號之後**，單獨寫成一行會被忽略。可用的值：`color`／`spacing`／`radius`／`shadow`／`font`／`other`。

**③ `theme.css`：主題寫成 `:root[data-theme="dark"]`，而且要重新定義至少一個 `:root` 已經有的 token**，才會被收進 manifest 的 `themes`；只寫選擇器卻沒有覆寫任何既有 token 的話不算一個主題。

**④ 每個元件一個資料夾、三件套：**

```
components/Button/Button.jsx    ← 實作，必須是 ESM export（例如 export function Button(…)）
components/Button/Button.d.ts   ← 型別，取第一個 interface；名稱尾綴 Props 會被去掉當元件名
components/Button/button.html   ← 預覽卡，第一行 <!-- @dsCard group="Components" name="Button" -->
```

- **實作檔一律用 `.jsx`，不要用 `.tsx`**：最終 bundle 只過 babel 的 `react` preset，**沒有 TypeScript preset**——實作檔裡只要出現 TS 語法（型別註記、`interface`、`as`），**整包 bundle 都會轉譯失敗**，不是只壞那一個元件。型別只放 `.d.ts`。
- 預覽卡建議寫**純靜態 HTML**，樣式用 `<link rel="stylesheet" href="../../styles.css">` 接回根目錄那支入口。真的要在卡片裡長出元件，用 `<script src="../../_ds_bundle.js"></script>` 再取 `window.<Namespace>.<Name>`；直接寫 `<script src="…jsx">` 會被警告。
- 元件與卡片的配對規則：某個 `.jsx` 的預覽卡＝**同一個資料夾裡第一張** `@dsCard`。

**⑤ 選配的加分項**（不做也能過，做了體驗好很多）：

- 根目錄 `readme.md`：會被當成這套設計系統的使用指南，並注入到用它的專案裡。
- 根目錄 `thumbnail.html`：讓 manifest 的 `hasThumbnailHtml` 變 `true` 並自動截圖當封面。
- `templates/<slug>/index.html`，第一行 `<!-- @template name="…" description="…" -->`——**必須在 `templates/` 底下再包一層資料夾**，直接放 `templates/x.html` 會被忽略。

### 1d. 最後放哨兵，然後開瀏覽器觸發編譯

**⑥ 根目錄放一個哨兵檔 `_ds_needs_recompile`**，內容是 JSON：

```json
{ "by": "constellation" }
```

**這一步缺了，前面五步全部白做。**實測：不放哨兵直接上傳任何檔案，manifest 完全 byte-identical、一個字都不會變；反過來只上傳哨兵、其他一個字不改，就會觸發全量重新編譯。`by` 的值會成為 manifest 的 `source` 欄位，等一下用來驗證。

**⑦ 觸發編譯**：在瀏覽器開 `https://claude.ai/design/p/<projectId>`。app 端會重新編譯 `_ds_manifest.json`／`_adherence.oxlintrc.json`／`_ds_bundle.js`，然後**自動把哨兵刪掉**——**哨兵消失就是編譯成功的訊號**。

### 1e. 驗證（不要靠「我推上去了」自我宣告）

讀 `_ds_manifest.json` 對三件事：

- `source` 要等於你在哨兵裡寫的 `by`（例如 `constellation`）。**還是舊值就代表根本沒編譯**，回去檢查哨兵有沒有真的放到根目錄。
- `tokens`／`components`／`globalCssPaths` 都不該是空陣列。空的就代表對應那類檔案形狀不對（最常見是 CSS 沒被 `@import` 鏈串到、或 token 沒宣告在 `:root`）。
- **卡片預覽是非同步渲染的**：上傳完不會立刻看到圖，要等 app 端編譯完。實測曾經因為 reload 太快就誤判成「渲染失敗」——**等一下再看，別急著判定失敗**、更別急著重推一輪。

### 1f. DesignSync 呼叫的實測坑

- **`finalize_plan` 的 `deletes` 是必填**——沒有要刪任何東西也要給一個空陣列，漏掉會直接失敗。
- `write_files` 每次最多 256 個檔；每個檔的 `localPath` 必須落在 `finalize_plan` 核准過的 `localDir` 裡面。
- **`localDir` 指到 repo 外的暫存目錄**（例如系統暫存區底下開一個工作資料夾），不要指到 repo 裡面——這些檔案是為了推上去而擺的中繼物，repo 這邊不留設計系統快照（理由見 1b）。
- **`register_assets` 確實不需要呼叫**（工具說明把它標成 legacy 是對的）：`@dsCard` 註解就足以填出 manifest 的 `cards`，連 `name`／`subtitle`／`viewport` 都帶得進去。網路上流傳「一定要呼叫 `register_assets`」在這條路徑上不成立，照那樣做只是多繞一步。
