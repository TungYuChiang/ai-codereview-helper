# diff-render (unit 9/12, layer 6)

2026-07-20 · commit `826d088`

## 變更摘要

把每個變更點的內容區從 placeholder 換成真正的 diff 呈現，新增 side-by-side 模式，
接上 Prism 語法上色。另補上 repo 清單為空時的首次執行引導畫面。

Prism vendor 到 `public/vendor/`——static 路由只開放 `public/`，且專案無 build step，
所以只能用一般 `<script>` / `<link>` 載入。

## side-by-side 的配對規則

一段連續的 N 個刪除接 M 個新增，前 `min(N,M)` 列配對，剩下的成為單邊列。
關鍵細節：**被 context 行隔開的刪除與新增不得跨越 context 配對**——那是兩處
不同的改動，硬配在一起會讓使用者以為它們相關。

## Prism 與 diff 底色的疊加

刻意不使用 Prism 的 `language-*` class，因為它自帶不透明的 `background: #f5f2f0`，
會把 diff 的紅綠底色整個蓋掉。改為手動呼叫 `Prism.highlight()` 取得已 escape 的
HTML，底色留在容器層。針對 `.token.operator` / `.entity` / `.url` 的背景覆寫
限縮在 `.diff-code` 底下，不會外溢到未來其他 Prism 用途。

## 測試結果

沒有 Node 單元測試（純瀏覽器 DOM）。7 條 AC 全部瀏覽器實測、6 張截圖佐證、
零 console 錯誤。素材含 JS 檔、CSS 檔、未知副檔名 `.txt`、以及內容含
literal `<script>` / `<b>` 的改動。

## Review

Spec ✅，Quality Approved，無 Critical / 無 Important。

Reviewer 的驗證方式值得記錄，兩項都不是靠讀程式碼能得到的結論：

1. **XSS**：實際餵入 `<script>alert(1)</script>` 與 `<img src=x onerror=alert(1)>`，
   確認兩者都渲染成逸出後的文字、DOM 裡沒有被注入的元素、`document` 上的
   `<script>` 數量維持在合法的 2 個。並確認 `public/` 內唯一的 `innerHTML`
   指派來源只有 `Prism.highlight()` 的回傳值，而該函式的 `_.util.encode()`
   步驟無條件 escape `&` 與 `<`，即使用 markup grammar 上色 HTML 內容也成立。
2. **`Line` 唯讀契約**：寫了一個 harness 把 `renderUnified` / `renderSideBySide` /
   `pairLinesForSideBySide` 等函式從 `app.js` 原封不動抽出來，餵 `Object.freeze()`
   過的 Line 物件跑完兩種模式，確認沒有非法寫入、沒有多出屬性。

side-by-side 的配對也用 N<M、N==M、N>M、純新增、純刪除、以及「刪除與新增被
context 隔開」六種形狀逐一驗過。

## 備註

兩個 Minor 已轉交給 `visual-redesign` 一併處理（它正在改同樣的檔案）：

- `dom.changePoints` 的形狀註解沒跟上，少了 `contentEl` 欄位。後面還有兩個 unit
  會把那行註解當契約讀。
- `.diff-side` 缺 `min-width: 0`，單一長行會把自己那欄撐開（300 字元的行造成
  2421px 對 75px），整個內容區橫向捲動而非各欄自理。
