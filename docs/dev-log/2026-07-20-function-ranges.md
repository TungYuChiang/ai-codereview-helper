# function-ranges (unit 2/11, layer 0)

2026-07-20 · commits `dfb91d6`..`2d33f77`

## 變更摘要

實作 `functions.js` — 用 acorn 找出檔案裡每個「最外層具名單位」的起訖行。
下游 `model.js` 靠這些範圍把 diff 變更行分桶到各 function 底下。

`getFunctionRanges(filePath, content)` → `[{ name, startLine, endLine }]`，
1-based 頭尾皆含，依 startLine 遞增排序。

認得 `.js` / `.mjs` / `.cjs` / `.jsx`，其餘副檔名一律回 `[]`。
涵蓋 function declaration、`const f = () =>`、`X.prototype.y = function`、
class method（`Foo.bar`）、物件字面值 method（`API.foo`）等具名形式。

AST 走訪為手寫遞迴（不引入 `acorn-walk`）。結構上只在 `Program.body` 與
IIFE body 兩處往下遞迴，其餘節點一律當葉節點記錄後停住——這在結構上保證
巢狀 closure 不會外洩成獨立項目。

## 修改的檔案

- `functions.js`（新增）
- `test/functions.test.js`（新增）

## 測試結果

`npm test` → 63 pass / 0 fail。

測試全部用 `assert.deepEqual` 斷言完整的 `{name, startLine, endLine}`，
而非只檢查「有回東西」——下游要拿行號做分桶，範圍錯了會靜默把勾記到別的
function 上，所以精確斷言是必要的。

## Review

Spec ✅，Quality Approved（無 Critical / Important）。

Review 過程補了兩件事：

1. **export 解包**（實作者自行加入）。brief 規定先以 `sourceType: 'module'`
   解析，那 `export function foo(){}` 就是明確在範圍內的輸入；不解包的話這類
   檔案會解析成功但回 `[]`，正是 IIFE 規則想防的同一種靜默失敗。判定為對規格
   意圖的合理延伸，保留。
2. **revealing module 穿透**（review 後修正）。`var API = (function(){...})();`
   這種把 IIFE 當變數初始值的寫法原本回 `[]`。舊式 JS 極常見，且失敗方式同樣
   是「整份檔案抓不到任何 function」。修正為複用既有的 `getIifeCallee` /
   `collectFromFunctionBody` 穿透，補 8 個測試。

## 備註

留給最終整體 review 的 Minor：

- `class Foo { constructor(){} }` 會產出 `Foo.constructor` 一筆。符合 brief
  的字面規則（表格未排除 constructor），但下游呈現時要意識到。
- 非頂層的 IIFE（包在某個 function 裡的）不穿透。符合規格，僅記錄。
