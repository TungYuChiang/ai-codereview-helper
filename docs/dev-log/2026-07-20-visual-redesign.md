# visual-redesign (unit 10/12, layer 6)

2026-07-20 · commits `620672a`..`e77b5b7`

## 起因

使用者看過畫面後說「這 UI/UX 也太醜了」。原 spec 完全沒涵蓋視覺設計，
所以這是追加的 unit。

## 設計來源與取捨

用 ui-ux-pro-max 產出設計系統，得到 Dark Mode (OLED) + JetBrains Mono /
IBM Plex Sans + 綠色 accent，定位為 developer tool。但它輸出的三個部分被否決，
記錄在 `design-system/local-code-review/ADDENDUM.md`：

| 否決項 | 理由 |
|---|---|
| Bento Grid / Hero / CTA 版面樣板 | 那是 landing page 結構。本產品是雙欄工作介面，沒有 hero、沒有轉換漏斗 |
| 整份 mobile checklist（44pt 觸控、bottom nav、safe area） | 桌面鍵盤驅動工具。硬套觸控尺寸會犧牲資訊密度，而密度正是這工具的核心價值 |
| Google Fonts CDN | 本機離線工具、static 路由只開放 `public/`。字體必須 vendor |

## 實際改了什麼

- 全面 token 化的深色配色，含 `prefers-color-scheme: light` 的**對應**而非反相
- IBM Plex Sans 400/500/600 與 JetBrains Mono 400/500 vendor 到
  `public/vendor/fonts/`（latin subset），無任何外部來源
- 三層樹改以字體 / 字重 / 字級區分，不再只靠縮排。檔案層目錄灰、檔名白
- 檔案與 function 層加 2px 進度條，「還剩多少沒看」從閱讀變成掃視
- 變更點去外框、改左側色條，四種狀態一套語言
- 原生 `select` 與 `checkbox` 重繪（深色底下 OS 會渲染成亮色方塊）
- 底部常駐鍵盤提示列
- 變更點標題列 sticky

## 驗證結果

15 張截圖，12 條 AC 全部瀏覽器實測，零 console 錯誤，既有 282 個測試維持全綠。

## Review

首輪 **Not Approved**，一個 Important：

**repo 下拉吃掉整條頂列。** option 文字是「名稱 (完整絕對路徑)」且無寬度限制，
實測 937px / 1280px——單一控制項佔 73%。這直接違反此次重新設計的第一原則。
改為只顯示名稱、完整路徑放 `title`、加 `max-width` 與 ellipsis。
basename 相同時附加上層目錄名區分（`app — work` / `app — side`），
避免為了簡潔而讓兩個同名 repo 分不出來。修正後 101–220px。

一個 Minor：current 與 current+read 的色條是同一個 token，只差 25% 透明度。
改為在已讀的色條上加一道凹口，讓狀態多一個形狀通道而不只是明暗差。

再審 Approved。

## 我判斷錯的地方

我從截圖懷疑「已讀沒有淡化」，要求 reviewer 必查。實際上是對的——opacity 套在
`.changepoint-header` / `.changepoint-content` 兩個子元素而非容器上，所以截圖裡的
色條維持全亮、只有內容變淡，而我把「色條還是亮的」誤讀成「整塊沒淡化」。

教訓：視覺狀態要用 computed style 量，不要用眼睛看截圖下結論。reviewer 就是這樣做的。

## Review 的驗證手法值得記錄

這輪 reviewer 做了幾件實作者沒做到的事：

- 把 `window.matchMedia` patch 成回報 `prefers-reduced-motion: reduce`，再真的點一次，
  確認 `scrollIntoView` 收到 `behavior: "auto"`；移除 patch 後變回 `"smooth"`。
  實作者原本只做靜態程式碼檢查。
- 真的按 `Tab`（而非呼叫 `.focus()`）驗證 focus ring 與 `:focus-visible`。
- 把 `#main-pane` 捲到變更點頂端跑出畫面（-60px）後，確認標題列仍固定在 74px——
  證明 sticky 真的在作用，不只是宣告了。
- 確認 `document.fonts` 對五個字體檔都回報 `status: "loaded"`，且 computed
  `font-family` 的首選確實是 vendor 的那份，不是靜默 fallback 到系統字體。
