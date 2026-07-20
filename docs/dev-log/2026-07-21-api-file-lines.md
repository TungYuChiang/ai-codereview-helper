# api-file-lines（使用者追加需求）

2026-07-21 · commits `40518d0`..`3eeea07`

## 起因

使用者要 GitHub / GitLab 那種「在 diff 上下點一下就把未修改的程式碼展開進來」的
體驗。前端手上只有 diff 出現過的行，要把周邊補進來必須跟 server 要。

## 成果

`GET /api/lines?repo=&ref=&path=&start=&end=`
→ `{ path, ref, start, end, totalLines, lines: [{n, text}] }`

1-based 頭尾皆含，超出範圍自動夾住（展開到檔首/檔尾本來就會超出），單次上限 2000 行。

## Review：一個 Critical

**symlink 逃逸 → 任意檔案讀取。**

路徑檢查是純字串運算（`path.resolve` / `path.relative`），沒有解析 symlink。
`WORKING_TREE` 模式走 `readFile`，而 `readFile` 在 OS 層**會跟隨 symlink**。
所以 repo 內一個指向外部的 symlink 就能讀到任意檔案，實測回傳 200 與目標內容。

攻擊情境完全貼合本工具的正常流程：git 支援追蹤 symlink，所以一條含
`ln -s ~/.ssh/id_rsa leak.txt` 的 branch，被 checkout 下來 review 的那一刻
（就是使用這個工具的前提動作），那就是磁碟上一個真的 symlink。

走 git ref 不受影響——`git show <ref>:<symlink>` 回傳的是連結目標的**字串**
而非跟隨後的內容。

## 修正的位置比要求的更好

我在派工時說「只有 `WORKING_TREE` 那條需要」。實作者把檢查放進 `git.js` 的
`getFileContent` 內部瓶頸，理由是 `/api/diff` 與 `/api/export` 在
`target=WORKING_TREE` 時走的是同一個函式。

**那兩個 endpoint 一直有同樣的漏洞，只是沒人發現。**

再審沒有接受「同一類漏洞」這個說法就放行，而是做了 PoC：修正前的版本上，
一個 tracked symlink `leak.js` 指向含 `function getApiKey() { return "TOP-SECRET..." }`
的檔案，對它留一則普通 comment，按「匯出我的疑問」——祕密內容原封不動出現在
匯出文字的「Function 原始碼」區塊裡。

也就是說，修正前一條惡意 branch 能讓使用者在毫無察覺下，把 repo 外的檔案內容
貼進要給 Claude 的 prompt。

把防護放在單一瓶頸而非各呼叫點，正是避免「防護只落在其中一個入口」——
而那恰好就是這個 bug 一開始的成因。

## 測試品質：第四次同樣的問題

原本 8 條路徑穿越測試，在把防護整個移除後仍有 **3 條會通過**。
它們靠的是 git 自己會拒絕 `git show HEAD:../../etc/passwd`——一個測試從未
意識到、也從未聲明依賴的巧合安全網。而 `WORKING_TREE` 沒有這個安全網，
且完全沒有測試覆蓋。

這是本專案第四次出現「測試在未修正的程式碼上也會通過」
（前三次在 `repo-config`、`change-point-model`、`server-api`）。

修正後採用的驗證方式已固定為專案慣例：**把防護拿掉，確認每一條安全測試
確實會失敗**。這次的結果是 321 → 318 過 3 敗，失敗的正是那三條，其餘無連帶損壞。

## 其他

- 工作區讀取加 10MB 上限（git 那條本來就有 `maxBuffer` 保護）
- hardlink 無法被 realpath 擋下，這是該方法的邊界而非缺陷：hardlink 沒有
  獨立的 realpath，且建立它本來就需要攻擊者已有本機同卷寫入權
- macOS 的 `/tmp` → `/private/tmp` 本身是 symlink，realpath 檢查很容易在此誤殺。
  已確認合法情境（repo 建在 `/tmp` 底下）不受影響
