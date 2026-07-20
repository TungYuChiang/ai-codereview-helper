# change-point-model (unit 4/11, layer 1) ★核心

2026-07-20 · commits `967194f`..`8d641ba`

## 變更摘要

實作 `model.js` — 把 diff 變更行按所在 function 分桶，合成三層樹
（檔案 → function → 變更點）。`buildTree(fileDiffs, rangesByPath)` 為純函式，
不 import `git.js` / `functions.js`，由呼叫端備妥兩個輸入。

**行歸屬**用新版檔案行號與一個游標：context 與 `+` 行取自身 `newLine`；
`-` 行沒有 `newLine`，取當下游標值（即「這行原本會出現的位置」）。

**切割**在單一 hunk 內把連續且同 owner 的行切成 segment，owner 一變就換段；
純 context 的 segment 丟棄不成為變更點。這自然同時滿足兩條規格要求：橫跨兩個
function 的 hunk 拆成兩個變更點，而同一 function 的多個 hunk 因分屬不同 hunk
本來就是不同 segment，絕不合併。

**樹序 == 捲動序**：group 依「第一個變更點的 newStart」排序；檔案層變更點不塞成
單一 group，而是依連續區段切成多個 `name: null` group，否則散落在多個 function
前後的檔案層改動會讓樹序和右側捲動順序對不起來。

非 JS 檔（`rangesByPath` 給 `[]`）走一般路徑就自動降級成兩層，**無任何特例程式碼**。

## 修改的檔案

- `model.js`（新增）
- `test/model.test.js`（新增）

## 測試結果

`npm test` → 124 pass / 0 fail。

## Review

Spec ✅，Quality Approved，**無 Critical、無correctness 缺陷**。

Reviewer 用 22 個注入的粒度 bug 做 mutation testing，殺掉 17/20 個——包含所有
規格點名為災難級的失效：游標雙向 off-by-one、segment 誤合併、context 混進
`diffText`、行號洩漏進 `diffText`、`startLine`/`endLine` 邊界包含性、巢狀範圍選擇、
輸入被 mutate。並獨立驗證了六個高風險情境（function 邊界上的刪除行、
A→B→A 的 owner 擺盪、夾在中間的純 context 段、`diffText` 的位置無關性、
deep-freeze 輸入、亂序 hunk 的 group 排序）。

三個存活的 mutant 都是**缺回歸防護**而非缺陷，已補：

1. 同名 function 的切割只在 grouping 層有測試，segmentation 層沒有。
   把 identity 比較改成 name 比較後整套測試仍綠——而那個 mutant 會讓一個勾
   靜默涵蓋到使用者沒看過的第二個 function。補了單一 hunk 橫跨兩個同名範圍的測試。
2. `groups.sort()` 從未被實際運用（所有 fixture 的插入順序恰好已排好）。
   補了亂序 hunk 的 fixture，移除或反轉排序都會失敗。
3. `rangesByPath[path]` 會走 prototype chain，檔名叫 `constructor` / `toString` /
   `__proto__` 時會拿到非陣列而拋錯。改用 `Object.hasOwn`。
4. 行型別判斷從 `!== '-'` 改為明確比對 `'+'` / `' '`，未知型別跳過而非污染游標。

修正後 reviewer 親自套用 mutant 驗證新測試確實會失敗、還原後再度全綠。

## 備註

留給最終整體 review 的 Minor：

- 排序在 group 粒度進行，因此若某個 null group 的變更點跨越了某個 function
  group，順序無法靠排序救回。真實 git 不會亂序輸出 hunk，故不可達；已加註解
  說明這個前提。
- `segment.lines` 與輸入共用 `Line` 物件參考。合乎規格（只禁止 mutate 輸入），
  但下游（含 UI 想掛 Prism 上色結果時）必須視為唯讀；已加註解。
