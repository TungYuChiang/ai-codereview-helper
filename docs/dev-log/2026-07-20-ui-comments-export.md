# ui-comments-export (unit 11/12, layer 6)

2026-07-20 · commit `82ebbb8`（Critical 於 `cf2362d` 一併修正）

## 變更摘要

這是「可用」的分界點。加上留 comment、孤兒區、兩顆匯出按鈕。

comment 存檔後就地更新，不重抓整棵樹。`Esc` 取消、`⌘/Ctrl+Enter` 存檔、
清空後存檔等同刪除。另加了一顆直接刪除鈕。

孤兒區呈現「變更點已消失但仍有 comment」的項目，帶 filePath / functionName /
diffText 快照。「保留」不需要任何操作——不動它就是保留，UI 上有寫明。

匯出走剪貼簿；失敗時退回可全選的 textarea 並說明原因。

`appState.isEditing` 是留給鍵盤 unit 的交接點。

## Review

Spec ❌ / Quality **Not Approved**，一個 **Critical**：

`saveComment()` 在成功後**無條件**清掉 `appState.isEditing` 與 `editingKey`，
不管存的是不是當前正在編輯的那一則。所以「正在編輯 A 的 comment → 點 B 的
刪除鈕」會讓 A 的編輯框還開著、旗標卻被清掉。而鍵盤 unit 被要求無條件信任
那個旗標，屆時在 A 的框裡打字就會觸發單鍵快捷鍵。

值得記的是：實作者確實找過這類 bug，還修掉了一個（開著編輯器時再開另一個），
修正加在 `enterCommentEdit` 裡。但刪除鈕走的是直接呼叫 `saveComment` 的路徑，
完全繞過那個守衛。Reviewer 是靠「開 A 的編輯器 → 點 B 的刪除鈕」這個具體
操作序列撞出來的——讀 code 很難想到要把這兩個動作交叉。

修正為只在 `appState.editingKey === entry.changePoint.id` 時才清除。

## 備註

Minor：匯出按鈕在還沒設定任何 repo 時就已掛上事件，點了會靜默無事發生，
而非停用或隱藏。
