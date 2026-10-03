# Constellation 出貨驗證證據

> 由 `verify-runner.mjs --scope ship` 寫入，證據筆格式與票內完全相同（見 DESIGN.md §5）。

## 驗證證據

- **2026-10-03T13:09:35.317Z**
  - `node --test "gates/test/*.test.mjs"`（exit 0）
    ```
    ℹ tests 610
    ℹ suites 94
    ℹ pass 610
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 274052.7464
    ```
  - 耗時：合計 275s｜node --test "gates/test/*.test.mjs" 275s
  - sig: aaaf423098091063712251383f32d44a6ca9cf01eee5a84e17b30e7187bc5ee8
