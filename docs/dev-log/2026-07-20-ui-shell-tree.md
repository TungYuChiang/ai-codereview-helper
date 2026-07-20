# ui-shell-tree (unit 8/11, layer 5)

2026-07-20 · commit `856d483`

## 變更摘要

第一個前端 unit：`public/index.html` / `app.js` / `style.css`。
版面骨架、頂列（repo 下拉、base/target picker、檢視模式切換、總進度）、
左側三層樹。vanilla JS、無框架、無 build step。

`name` 為 `null` 的 group 不多渲染一層，其變更點直接掛在檔案底下——這就是規格
「非 JS 檔自動降級成兩層」在畫面上的樣子。注意 `model.js` 會產生**多個**交錯的
null group（為了維持樹序與捲動序一致），所以這裡不能假設只有一個。

打勾走 `POST /api/check` 後**就地**更新該變更點與上層計數，不重抓整棵樹——
重抓會讓捲動位置跳掉，而使用者正在逐段閱讀。

## 修改的檔案

- `public/index.html`（取代 server unit 留的 placeholder）
- `public/app.js`（新增）
- `public/style.css`（新增）
- `docs/dev-log/screenshots/`（13 張驗收截圖）

## 驗證結果

沒有 Node 單元測試（純瀏覽器 DOM），改以實際開瀏覽器逐條驗收：
13 條 AC 全部確認、13 張截圖佐證、零 console 錯誤。素材是臨時 repo，
刻意包含三層 JS 樹、兩層降級的 CSS 檔、交錯的 null/named group，
以及一個檔名含 HTML metacharacter 的檔案用來驗 XSS 安全。

驗證過程中自己抓到一個 bug：`#add-repo-form { display: flex }` 的 ID 選擇器
優先權蓋過 `hidden` 屬性，導致新增 repo 的表單在載入時就展開。

## Review

Spec ✅，Quality Approved，無 Critical / 無 Important。

Reviewer 額外確認了兩件平行開發最容易出事的接縫：

1. **XSS**：`public/` 裡 `innerHTML` / `outerHTML` / `insertAdjacentHTML` /
   `document.write` 零出現；連 `aria-label` 也只嵌數字範圍、不嵌檔名，
   所以沒有二次注入向量。
2. **與硬化後的 server 相容**：`server.js` 在本 unit 寫完之後才加上 JSON
   Content-Type 要求與跨站檢查。Reviewer 實際起 server 跑完整流程，確認
   兩個 POST 都有帶 Content-Type、三個 GET 不經過 body 檢查、同源 fetch
   自然帶 `Sec-Fetch-Site: same-origin`，全部 200 且無 console 錯誤。

四個留給後續 unit 的擴充點逐一查核為「真的有在用、各只有一個呼叫點」：
`renderChangePointContent`（下一個 unit 直接換掉函式本體、呼叫端零改動）、
集中的 `appState`、`selectChangePoint` / `moveSelection`（鍵盤 unit 可直接呼叫，
`moveSelection` 已正確處理邊界）、以及左右兩側都有的 `data-key`。

## 備註

留給最終整體 review 的 Minor：repo 清單為空的真.首次執行狀態，`init()` 會提早
return，畫面只剩一條空的頂列、沒有任何「還沒有 repo，先新增一個」的引導。
這是使用者第一次啟動時會看到的畫面，已交給下一個 unit 一併補上。
