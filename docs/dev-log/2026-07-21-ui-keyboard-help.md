# ui-keyboard-help (unit 12/12, layer 6)

2026-07-20/21 · commits `cf2362d`..`e0c2c85`

## 變更摘要

最後一棒。`j`/`k` 移動、`x` 勾選（勾起來時前進、取消勾不動）、`u` 跳下一個未讀、
`c` 開 comment、`f` 折疊、`1`/`2` 切換檢視、`?` 速查表。`space` 完全不攔截。

兩道**獨立**的防線避免在輸入框內誤觸：`appState.isEditing`，以及事件目標為
文字輸入元素時直接略過。Reviewer 實測確認兩者確實獨立——把 DOM focus 移出
textarea 後，`isEditing` 仍能單獨擋住 `x`。

## Review

Spec ❌ / **Not Approved**，兩個問題加一個既有 bug：

**1. `space` 在存檔或取消 comment 後會觸發按鈕而非捲動。** 新的 keydown handler
確實沒綁 `' '`，但 `renderCommentView(..., { focusTrigger: true })` 會把 focus
放到 Edit 按鈕上，於是瀏覽器預設行為接手。這正好打斷 brief 自己描述的主要
節奏：「存完 comment，按 space 繼續往下讀」。改為 focus 到不可觸發的容器。

**2. checkbox 被當成輸入框。** `isTypingTarget` 無條件比對 `tagName === 'INPUT'`，
所以用滑鼠勾一個變更點之後，所有快捷鍵失效到 focus 移開為止。改為只排除
真正的文字輸入情境。

**3. scroll-spy 溢出（既有 bug，本輪一併修）。** 見下。

## scroll-spy：一個「假設過期」的 bug

`handleIntersections` 只檢查每次 `IntersectionObserver` callback 的差異批次，
沒有追蹤累積狀態。兩個相鄰且短的變更點會互相蓋掉。

實測：12 次單步移動中有 1 次跳兩格。它同時污染 `x` 的自動前進落點，
而最嚴重的是 `u`——它宣稱跳到「下一個未讀」，卻可能靜默地送到**已讀**的
變更點，沒有錯誤、沒有任何提示。

**這是打勾機制存在的唯一保證被破壞。** 整個工具的目的就是讓使用者能相信
「這段我讀過了」；一個說「下一個沒讀的」卻交出已讀內容的指令，比沒有這個
指令更糟。

它的來歷值得記：這段程式碼是 `ui-shell-tree` 寫的，當時通過了 review——
因為在滑鼠操作下它幾乎無害（點哪到哪，捲動高亮跟丟一格無傷大雅）。是最後
一棒把 `j`/`k`/`u` 變成主要操作路徑之後，同一段程式碼才從「小瑕疵」變成
「破壞核心保證」。

**不是寫錯，是假設過期。** 分層開發必然產生這種東西，而且只有把整條路徑
當成真人操作跑過才抓得到——這也是為什麼每個 UI unit 都要求實際開瀏覽器
逐條驗收，而不是讀 code 打勾。

改為持久化的 `Map<key, {isIntersecting, top}>`，每次 callback 由完整狀態推導
當前選取。實測 24 次單步移動全部正確，`u` 不再落在已讀處。
