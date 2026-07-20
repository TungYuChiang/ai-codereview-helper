# diff-parser (unit 1/11, layer 0)

2026-07-20 · commits `7a90119`..`b5cee35`

## 變更摘要

實作 `git.js` — pipeline 第一站，執行 git 並把 unified diff 解析成下游依賴的資料結構。

匯出四個 API：

- `listRefs(repoPath)` → `{ branches, tags, current }`
- `getDiff(repoPath, base, target)` → raw diff 字串；ref↔ref 用 three-dot，
  target 為 `null` / `'WORKING_TREE'` 時省略 target
- `getFileContent(repoPath, ref, filePath)` → 檔案內容；缺檔回 `null`
- `parseDiff(raw)` → `FileDiff[]`（純函式）

資料結構 `FileDiff` / `Hunk` / `Line` 為下游契約，欄位與 null 慣例逐字固定。

## 修改的檔案

- `git.js`（新增）
- `test/git.test.js`（新增）
- `package.json`（新增；test script 為 `node --test 'test/**/*.test.js'`
  —— 本機 Node 25.9.0 無法解析傳給 `node --test` 的裸目錄路徑）

## 測試結果

`npm test` → 25 pass / 0 fail。

`parseDiff` 的測試用寫死的 diff fixture；`listRefs` / `getDiff` / `getFileContent`
用 `fs.mkdtemp` 建臨時 repo 實測，涵蓋 modified / added / deleted / renamed / binary、
`\ No newline at end of file`、以及真實 divergent history 的 three-dot 語意。

## Review

Spec ✅（六條 AC 全數達成，無 scope creep）。

Quality 首輪 Not Approved，一個 Important：`getFileContent` 對所有 `git show` 失敗
都回 `null`，違反「git 錯誤不得吞掉」的全域約束。修正為只在 git stderr 指出
`path ... does not exist in` / `exists on disk, but not in` 時回 `null`，其餘照拋。
另修正一條測試斷言 `/Error/` 過於寬鬆的問題。再審 Approved。

## 備註

留給最終整體 review 的 Minor findings：

- `diff --git a/X b/Y` 的路徑 regex 不處理含空白或引號的路徑。非二進位檔有
  `---`/`+++` 行可退回，二進位檔則會靜默得到空路徑。
- 「純函式不碰檔案系統」的測試只斷言不拋例外，未真正證明該性質。
- renamed + binary 同時成立時 `oldPath` 被丟棄（status 硬寫為 `binary`）。
- `listRefs` 只列 local branch，不含 remote-tracking。單人本機工具下為合理取捨。
