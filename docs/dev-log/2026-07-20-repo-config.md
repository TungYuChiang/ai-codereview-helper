# repo-config (unit 3/11, layer 0)

2026-07-20 · commits `0acd281`..`1a63cb8`

## 變更摘要

實作 `config.js` — repo 清單設定，以及設定 / 進度檔在家目錄的路徑建構。
另因 review 發現的競爭問題，新增 `lock.js`（通用 mutex）。

`$LCR_HOME`（預設 `~/.local-code-review`）底下：`config.json` 存 repo 清單，
`state/<repo-id>.json` 供之後的 `state.js` 存勾與 comment。base 目錄**每次呼叫時
才解析**，不在 module 載入時快取——測試靠改 `LCR_HOME` 導向臨時目錄，快取住會
讓測試污染真實家目錄。

`repoId` 用 slug + hash：路徑先正規化（絕對化、去尾斜線）再算，同路徑恆得同 id，
且只含 `[a-z0-9-]` 以便安全當檔名。

寫入原子化（暫存檔 + rename）。`config.json` 損毀時改名備份成
`config.json.corrupt-<timestamp>` 後視為空清單重建，不崩潰。

## 修改的檔案

- `config.js`（新增）
- `lock.js`（新增，review 後）
- `test/config.test.js`（新增）
- `test/lock.test.js`（新增，review 後）

## 測試結果

`npm test` → 98 pass / 0 fail。

所有測試把 `LCR_HOME` 指向 `fs.mkdtemp` 臨時目錄；已確認跑完測試後真實的
`~/.local-code-review` 依然不存在。

## Review

Spec ✅。Quality 首輪 **Not Approved**，一個 Important：

`addRepo` / `removeRepo` 的 read-modify-write 未序列化。並行呼叫時兩者都讀到
變更前的設定，後寫的把先寫的蓋掉——而且**被丟掉的那筆仍回報成功**，呼叫端
完全收不到訊號。這對常駐 server 是實際情境（連點兩下、開兩個分頁）。

修正方式是把 mutex 抽成獨立的 `lock.js`，而非塞在 `config.js` 裡：`state.js`
之後對每個 repo 的進度檔會有一模一樣的 read-modify-write pattern，現在立好
這個先例比事後補便宜。`config.js` 所有讀改寫路徑改走單一 module-level mutex。

同時修掉損毀復原分支未加保護的問題（並行 reader 下第二個 `rename()` 可能
ENOENT 拋成 unhandled rejection）。

再審 Approved。reviewer 另以「把 mutex 換成 no-op」與「把 try/catch 拿掉」
兩種方式交叉驗證，確認兩層防護各自獨立有效。

## 備註

留給最終整體 review 的 Minor：

- 「並行 reader 不會看到 uncaught rejection」這條測試目前被 mutex 遮蔽，
  就算未來有人拿掉 `config.js` 的內層 try/catch 它仍會通過。要真正守住得用
  繞過 lock 的方式測。
- corrupt 備份檔名用毫秒時戳，同毫秒內理論上會碰撞。單人本機工具下無實質影響。
- `addRepo` 的兩次 `stat()` 在進 mutex 之前，因此「先呼叫者先進佇列」對
  `addRepo` 不保證。不影響正確性，寫入仍完全序列化。
