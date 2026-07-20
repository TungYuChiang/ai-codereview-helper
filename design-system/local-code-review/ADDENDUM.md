# Addendum — 本專案的偏離與補充

`MASTER.md` 由通用設計系統產生器輸出，以下是針對本產品的裁決。
**衝突時以本檔為準。**

## 採用 MASTER 的部分

- **Dark Mode (OLED) 色盤**（`#0F172A` 底 / `#22C55E` accent / `#EF4444` destructive）。
  這工具會開在編輯器旁邊，而編輯器通常是深色；亮色版本會在視線切換時造成刺眼落差。
- **JetBrains Mono + IBM Plex Sans** 的字體搭配。
- 語意化色彩 token、focus 可見性、對比度要求、`prefers-reduced-motion`、
  150–300ms 過場。

## 否決 MASTER 的部分

| 項目 | 為什麼不用 |
|---|---|
| Pattern：Bento Grid Showcase（Hero / Tech Specs / CTA） | 那是 landing page 結構。本產品是雙欄工作介面，沒有 hero、沒有 CTA、沒有轉換漏斗。 |
| 整份 mobile checklist（44pt 觸控目標、bottom nav、safe area、手勢） | 這是桌面、鍵盤驅動的工具。主要操作是 `j`/`k`/`x`/`u`/`c`/`f`。把觸控尺寸硬套進來會犧牲資訊密度，而密度正是這工具的核心價值。 |
| Google Fonts CDN `@import` | 本機離線工具，且 server 只開放 `public/`。字體必須 vendor 到 `public/vendor/fonts/`，與 Prism 相同做法。離線可用是硬需求。 |
| 「Light ✗ No」（只做深色） | 深色為預設，但仍要以 token 實作，`prefers-color-scheme: light` 時給可用的亮色對應。使用者的系統設定不該被工具無視。 |

## 本產品的版面規則

### 資訊密度是第一原則

實際情境是「1300 行改動集中在兩三個大檔」。任何讓使用者多捲一頁的裝飾都是負分。
卡片外框、大留白、大圓角一律收斂。

### 左樹的三層必須一眼可辨

目前三層只靠縮排區分，這是最大的結構問題——它是主要導航卻是畫面上最弱的區域。

| 層級 | 處理 |
|---|---|
| 檔案 | IBM Plex Sans semibold；目錄路徑以 muted 色、檔名以 foreground 色，同一行內做明暗對比 |
| Function | JetBrains Mono medium，縮排一階 |
| 變更點 | JetBrains Mono regular、較小字級，行號範圍用 tabular numerals 對齊 |

進度不要只用右側的 `0/2` 灰字。檔案與 function 層在該列底部加一條 2px 的細進度條
（`--color-accent` 填色、`--color-muted` 底），數字保留但降為輔助。
理由：使用者最常問的問題是「還剩多少沒看」，那應該可以掃視而不是閱讀。

### 右側變更點

- 去掉整框邊界，改用**左側 3px 直立色條**表達狀態。這樣省下水平空間又更好掃視。
- 狀態語言統一為一套：
  - 未讀：色條 `--color-border`
  - 當前：色條 `--color-accent`，列底 `--color-muted`
  - 已讀：整塊 opacity 0.55，色條 `--color-accent` 但降透明度
  - 當前 + 已讀 可同時成立（色條維持全亮，整塊仍淡化）
- 每個變更點的標題列 `position: sticky`，捲動時保留「我在哪個 function 的哪一處」。

### Diff 行

- 一律 JetBrains Mono，行號用 `font-variant-numeric: tabular-nums` 避免跳動。
- `+` / `-` 用**低飽和底色**（accent / destructive 各約 12% 透明度），不要實色。
  實色底會蓋掉 Prism 的語法上色，兩者必須疊加而非互相打架。
- 行號欄與內容欄之間用 1px `--color-border` 分隔，不要用留白。

### 鍵盤優先

這是本產品與一般網頁最大的差異，也是 MASTER 完全沒涵蓋的：

- **focus ring 必須明顯**（2px `--color-accent`），且**絕不可移除**。使用者全程用鍵盤。
- 當前變更點的視覺強度要**高於**滑鼠 hover。hover 是次要的。
- `j`/`k` 移動時捲動要有 150ms 的平滑過場，讓使用者感知到位移方向；
  但 `prefers-reduced-motion` 時改為瞬間跳。

### 控制項

原生 `<select>` 與 `<input type=checkbox>` 一律重做樣式。
現況的原生控制項是畫面上最廉價的部分，且在深色底下會被作業系統渲染成亮色方塊。

- Checkbox：自訂方框 + `--color-accent` 勾記，尺寸 16px，含 hover / focus / checked 三態。
- Select：保留原生 `<select>` 元素（可及性與鍵盤行為免費），但以 CSS 重繪外觀。

## 字體 vendor 方式

從 Google Fonts 下載 woff2 放進 `public/vendor/fonts/`，以 `@font-face` 載入，
`font-display: swap`。只取實際會用到的字重：
IBM Plex Sans 400/500/600，JetBrains Mono 400/500。
不要把整個字族全帶進來。
