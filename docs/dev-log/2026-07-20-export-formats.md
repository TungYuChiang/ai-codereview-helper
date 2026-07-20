# export-formats (unit 6/11, layer 3)

2026-07-20 · commits `b0514ac`..`ba589fa`

## 變更摘要

實作 `export.js` — 把 review 成果匯出成兩種字串，都由前端複製到剪貼簿，不寫檔。

`toClaudePrompt(ctx)` 只含**有 comment 的變更點**（comment 就是「我有疑問的地方」，
那正是要交給 Claude 的；1300 行全塞進去只會稀釋重點）。每則帶檔案絕對路徑、
所在 function 的**完整原始碼**、該變更點 diff、使用者 comment。給完整 function
而非只給 diff 片段是刻意付出的 token 成本——只給片段的話 Claude 看不出 caller 關係。

`toMarkdown(ctx)` 是給 Obsidian 的筆記，全量結構化摘要。

兩者皆為純函式，**不 import 專案內任何模組**（只用 `node:path`），日期由 ctx 傳入
而非讀系統時鐘，因此輸出完全可重現、可精確斷言。

## 修改的檔案

- `export.js`（新增）
- `test/export.test.js`（新增，27 個測試）

## 測試結果

`npm test` → 253 pass / 0 fail。

## Review

Spec ✅（八條 AC 全met），Quality 首輪 **Not Approved**，兩個 Important：

**1. 有孤兒 comment 時誤報「沒有 comment」。** 判斷只看存活的變更點，忽略了
`orphans`——而孤兒依定義必然帶著一則真實 comment（它是在某個變更點上寫過、
之後那個變更點消失了才變成孤兒）。結果兩種格式都會在印出孤兒 comment 的前一行
宣告沒有 comment，Markdown 還與自己上一段的統計行 `1 則 comment` 矛盾。

這不是假想情境：任何一次 review 只要所有 comment 的變更點都被 amend 掉、
而孤兒記錄留存，就會踩到。

**2. 固定三重反引號的 fence 會被內容打斷。** 被 review 的檔案若是 `.md`，
或任何在字串/註解裡含有 fenced 片段的原始碼，內層的三重反引號會提前關閉外層
fence，該則之後的內容全部散成無格式文字。

改用動態長度 fence（CommonMark：N 個反引號的 fence 只會被 >=N 的連續反引號關閉），
長度取 `max(3, 內容中最長連續反引號 + 1)`。

修正時實作者額外把第三處 call site（孤兒的 diff 快照）也一併改掉——那處有完全
相同的弱點，且孤兒的 diff 內容與存活 diff 來自同一個內容宇宙，只修兩處等於留了
一條通回同一個漏洞的路。Reviewer 認可這個擴張。

再審 Approved，並以 A/B 方式確認新測試在修正前的 `export.js` 上確實會失敗。

## 備註

Markdown 對「零個有 comment 變更點」的檔案不輸出 `##` 標題（而非輸出空標題）。
這是實作者主動標記的判斷；review 後判定與格式的定位一致（它是 review 成果筆記，
不是完整 diff 存檔），予以保留。
