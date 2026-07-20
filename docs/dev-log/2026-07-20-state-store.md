# state-store (unit 5/11, layer 2)

2026-07-20 · commits `7ca0daf`..`e72f420`

## 變更摘要

實作 `state.js` — 勾與 comment 的持久化，以及 content hash 失效規則。

key = `sha256(檔案路徑 \0 function 名 \0 diff 內容 \0 同桶內出現序號)`，取前 16 字元。

由此得到規格要的四條行為：amend 後行號位移但內容沒變 → 勾保留；那段 code 真的被
改了 → 回到未讀；function 改名 → 回到未讀；變更點消失但有 comment → 進孤兒區。

`annotate(repoId, fileNodes)` 不修改輸入，回傳 `{ files, orphans, stats }`，
在 `model.js` 的形狀上疊加 `id` / `checked` / `comment` 與各層的 `checked` /
`allChecked`。

`CommentRecord` 額外存 `filePath` / `functionName` / `diffText` 快照——孤兒
comment 的變更點已不在當前 diff 裡，只存 key 的話 UI 只能顯示一串 hash，
使用者無從判斷該丟該留。

沿用 `lock.js`，**每個 repo 一把獨立 mutex**（不同 repo 寫不同檔案，不該互相阻塞）。
寫入原子化，state 檔損毀或 version 不符則備份後視為空狀態。

## 修改的檔案

- `state.js`（新增）
- `test/state.test.js`（新增，70 個測試）

## 測試結果

`npm test` → 215 pass / 0 fail。所有測試把 `LCR_HOME` 導向臨時目錄；
已確認跑完後真實的 `~/.local-code-review` 依然不存在。

## Review

Spec ✅。Quality 首輪 Approved 但附帶條件，四個發現：

**Important（規格層級）**：原本的 key 沒有序號，同一 function 內兩處**內容完全
相同**的改動會算出同一個 key。實測勾一個會讓另一個也顯示已讀、整個 function
被標記為看完。這是本工具最糟的失效模式——宣稱使用者讀過他沒讀過的程式碼，
而且靜默。Reviewer 正確地把它退回給規格擁有者而非自行修補。

修法是在 key 加入「同一 `(檔案, function, diff內容)` 桶內的第幾次出現」，
依樹的順序計算。行號位移時序號不變，因此不影響 amend 存活這條。
`spec` 文件的失效規則已同步更新。

連帶的 API 變更：`changePointKey(changePoint, ordinal)`，ordinal 必填且驗證。
序號只在 `annotate` 的樹走訪中計算——那是唯一有列舉脈絡的地方，讓外部
無法算錯。

其餘三個：`stats.comments` 依變更點而非依 comment 記錄計數（重複內容下會多算）；
宣稱驗證「每 repo 獨立鎖」的測試其實在單一全域 mutex 下也會通過（換成
300k 筆 state 檔製造可測量的時間差，並實測確認新測試在共用 mutex 下會失敗）；
`setComment` 缺 `context` 時把孤兒快照寫成 null，讓孤兒區只剩一串 hash
（改為拋出可讀錯誤）。

再審 Approved。

## 已知限制

**序號在插入時會位移。** 若在某個重複內容的**更前面**插入了新的同內容變更點，
後面兩個的序號各往後移一位。結果是：已勾的標記遷移到另一個實體上，
而真正被審過的那個回到未讀。

判定為可接受並記錄而非修掉：

- 觸發條件是複合的——要先存在位元組完全相同的重複內容，再有一次編輯在更前面
  插入同樣內容。比原本無條件觸發的 bug 窄得多
- 丟失的那個勾 fail-closed（強制重看），誤得的那個勾其內容與已審過的位元組完全相同
- 任何純序號方案都無法對插入免疫。要真正解決得存穩定 id（會破壞 amend 存活，
  那是整個 content hash 設計的目的）或把周邊 context 納入 hash（範圍大得多）
