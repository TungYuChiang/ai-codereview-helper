# server-api (unit 7/11, layer 4)

2026-07-20 · commits `f4dddbf`..`eaf74fc` 及後續收尾

## 變更摘要

`review.js`（進入點）+ `server.js`（HTTP + JSON API）——第一個真的會跑起來的 unit。
前面六個模組都是純函式，這裡負責 I/O 與組裝。

`server.js` 匯出 `createServer()` 回傳尚未 listen 的 Server，`review.js` 負責
listen 在固定 port 7777——這個切法讓測試能用 port 0 起臨時 server。port 被佔用時
印可讀訊息並以非 0 退出，不自動換 port（使用者的書籤依賴固定 port）。

取各檔新版內容以組出 function 範圍時會並行，但限制同時 8 個 git 子行程。

## 測試結果

`npm test` → 282 pass / 0 fail。含端到端測試：建臨時 repo → commit → 改 → commit
→ 註冊 → GET diff → POST check → 再 GET 確認勾還在，以及 amend 後行號位移仍存活。

## Review

Spec ✅。Quality 首輪 **Not Approved**，一個 **Critical 安全漏洞**：

**`base` 參數的 git 選項注入。** `base` 只驗了「非空字串」就進到
`git.getDiff`，而該處組出 `['diff', base]` 沒有分隔符，開頭是 `-` 的值會被 git
當成選項。Reviewer 實測 `GET /api/diff?repo=<id>&base=--output=/tmp/lcr-PWNED.txt`
回 200 並**真的建立了那個檔案**——任意檔案寫入。

更關鍵的是它可跨站觸發：當時沒有任何 Origin 檢查，又是普通 GET，所以使用者瀏覽
任何網頁時，頁面裡一個 `<img src="http://localhost:7777/api/diff?...">` 就會寫他的
檔案。repo id 是路徑的 sha256，可離線推算，不構成秘密屏障。

這是「本機工具只有我自己連」這個直覺的反例——localhost 對瀏覽器並不隔離。

三層修補：ref 參數驗證（擋開頭 `-`、空白、控制字元、`:`）、`git.js` 加
`--end-of-options`、所有 `/api/` 路由加跨站來源檢查並要求 JSON Content-Type。

其中一個只有實際去跑才會知道的細節：`git show` **不吃** `--` 分隔符
（`git show -- <rev>:<path>` 會靜默回空字串且 exit 0），所以 `getFileContent`
只能用 `--end-of-options`。

另修 `decodeURIComponent` 未保護導致格式錯誤 URL 回 500、JSON body 為 `null`
時回 500、request body 無大小上限。

再審 **Approved**：reviewer 用 16 種 payload × 兩個參數 × 三個 endpoint 都找不到
繞過路徑，並以原始 socket 重測 24 種路徑穿越向量確認防禦未被削弱。

## 註解的錯誤與修正

再審抓到一件比原漏洞更值得記錄的事：**跨站檢查的理由註解是錯的**。

註解宣稱「瀏覽器攻擊必定送出兩個標頭之一」。實際上跨站 `<img>` 是 no-cors GET，
瀏覽器不送 `Origin`；而 `Sec-Fetch-Site` 在 Chrome 76 (2019)、Firefox 90 (2021)、
但 Safari 要到 **16.4 (2023)** 才有。舊 Safari、舊 WebView、會剝除標頭的 proxy
都會送出兩個標頭皆無的跨站 GET，然後被放行。

放行的決定本身仍正確——那些路由全是唯讀、回應在同源政策下對攻擊者不透明、
真正危險的副作用已在另外兩層擋死、寫入端點是 POST 且要求 JSON Content-Type
（跨站 HTML form 送不出來）。剩下的影響只是多開一個 git 子行程。

但錯誤的註解會誘使未來的維護者把這道檢查當成密不透風而依賴它。已改為陳述實情，
並誠實記下 `Origin` 分支是拿客戶端自報的 `Host` 來比對，因此其保證強度等同 `Host`，
且 DNS rebinding 本來就不是任何標頭檢查擋得住的。

## 測試品質

再審把新測試拿去跑修正前的程式碼：86 個測試中 71 個通過、15 個失敗。
那 15 個涵蓋注入、跨站、I2、I3、M4，是真實的回歸防護。

但有四個測試在修正前也會通過，其中 `test/server.test.js:711` 更只是因為探測用的
檔名裡含有 "target" 這個字才匹配到斷言——完全抓不到東西。已全部改為斷言驗證
訊息本身，並在 `856d483` 的 clone 上逐一確認現在會失敗。

這是本專案第三次出現「測試看起來有守著、其實驗不到」的情況（前兩次在
`change-point-model` 與 `repo-config`）。共通模式是：斷言太寬（`notEqual(status, 200)`、
`/Error/`、裸的 400），寬到修正前的行為也能滿足。
