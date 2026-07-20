# ui-sidebar（使用者追加需求）

2026-07-21 · commit `90c1b2a`

## 起因

> 「檔案跟區段要做一些區別這樣才可以更方便」
> 「我希望這邊可以收縮起來」
> 「側邊欄UI 可以整體重新設計一番」

原因是檔案列與 function 列的視覺重量太接近。在 `mselector.js` 這種單檔 59 個
變更點、橫跨二三十個 function 的情況下，整條側邊欄讀起來就是一片密集的等寬文字。

## 做法

三層改為**三種不同性質**的處理，而非三種不同的字：檔案是容器（底色帶 + 分隔線 +
較高的 padding + 檔案間留白 + sticky）、function 是段落、變更點是項目。

驗收標準刻意設得很鈍：**把畫面縮到看不清文字，仍要分得出哪幾列是檔案。**
這條之所以能過，是因為設計把「形狀訊號」疊在字體訊號之上——底色、邊框、
高度、間距、導引線，即使文字本身糊掉仍然成立。

檔案列 sticky 是對 59 個變更點的檔案最有感的改善：捲到一半仍知道自己在哪個檔案。
reviewer 另外用三個等大檔案的素材驗了 sticky 的交接，確認任何捲動位置都恰好
只有一個 header 吸附，不會雙重吸附或殘留。

收合綁 `b`，狀態存 localStorage，已列入 `?` 速查表。

## Review

Spec ✅（13 條全過），Quality Approved，無 Critical / 無 Important 缺陷。

### 排除了當機的一整類機制

我在派 review 時加了一項任務：去找當機的機制，因為這次改動碰到捲動路徑，而
sticky + 捲動連動的樹正是那種「小素材便宜、真實規模昂貴」的東西。

結果是**排除性的**：

- 全檔 grep `addEventListener('scroll')` / `getBoundingClientRect` / `offsetTop` /
  `scrollHeight` — **零出現**。沒有捲動監聽器，沒有在熱路徑上強制同步 layout
- sticky 是純 CSS，每次捲動的 JS 成本為零
- 65 個變更點的壓測：樹捲動 171 步 0.85ms/步、主區捲動 717 步 0.76ms/步、
  連按 `j` 130 次 0.2ms/次，**全部零個 long task**
- 並以人工的 150ms busy-loop 反向確認觀測器本身有效——「零 long task」不是
  儀器沒裝好

## 一個重要的方法論注記

Reviewer 指出：自動化瀏覽器的分頁 `document.hidden` 恆為 true，會節流 rAF 驅動的
工作（CSS transition、平滑 `scrollIntoView`、`IntersectionObserver` 的派送），
在強制產生一個 frame（例如截圖）之前，這些會看起來像卡住。

**這很可能就是先前診斷當機時，我這邊分頁兩次「死掉」的真正原因**，而我當時把它
當成了產品的證據。記在這裡，以免下一個人重蹈覆轍。

## 備註

留給後續的 Minor：

- 檔案列底色 `--color-surface` 與 `--color-bg` 的差距只有 RGB 5–11，單獨當訊號很弱。
  目前不孤立（邊框、padding、間距、導引線都疊在上面），但若日後有人改成更窄更密的
  版面而拿掉其中幾個訊號，只靠底色撐不住
- 收合圖示的字元在 JS 與 `index.html` 各寫了一次，重複但無害
