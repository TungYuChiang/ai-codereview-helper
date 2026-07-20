# Development Progress

Generated: 2026-07-20
PRD: `docs/superpowers/specs/2026-07-20-local-code-review-design.md`

## DAG

```
Layer 0: diff-parser, function-ranges, repo-config          [parallel — no overlap]
Layer 1: change-point-model (deps: diff-parser, function-ranges)
Layer 2: state-store (deps: change-point-model)
Layer 3: export-formats (deps: change-point-model, state-store)
Layer 4: server-api (deps: state-store, repo-config, export-formats)
Layer 5: ui-shell-tree (deps: server-api)
Layer 6: diff-render (deps: ui-shell-tree)           [sequential — overlaps public/app.js]
         ui-comments-export (deps: ui-shell-tree)    [sequential — overlaps public/app.js]
         ui-keyboard-help (deps: ui-shell-tree)      [sequential — overlaps public/app.js]
         jarvis-skill (deps: server-api)             [parallel — no overlap]
```

**File overlap 分析**

- Layer 0 三個 unit 的 `touches` 兩兩無交集 → 可平行 dispatch
- Layer 6 的 `diff-render` / `ui-comments-export` / `ui-keyboard-help` 皆修改
  `public/app.js` 與 `public/style.css` → **必須序列執行**，順序如上
- `jarvis-skill` 只碰 jarvis 專案目錄，與任何 unit 無交集 → 可與 Layer 6 平行

## Units

### diff-parser
- **Spec 章節**: 架構 / Pipeline — `git.js`
- **Name**: Git 執行與 unified diff 解析
- **Scope**: 執行 git 指令並解析輸出。負責 `git diff <base>...<target>`（three-dot）與
  Working Tree 模式的 `git diff <base>`，把 unified diff 解析成「檔案 → hunk → 逐行標記
  (`+` / `-` / context)」的結構。另提供列出 branch / tag 的功能。純函式為主，吃字串吐結構。
- **Deps**: none
- **Tier**: 2
- **Touches**: `git.js`, `test/git.test.js`, `test/fixtures/*.diff`
- **Acceptance**:
  - [x] 解析 unified diff 得到檔案清單與各檔的 hunk
  - [x] 每個 hunk 有正確的新舊起始行號與逐行 `+`/`-`/context 標記
  - [x] ref↔ref 用 three-dot 語意組指令；target 為 Working Tree 時省略 target
  - [x] 能列出 repo 的 branch / tag 清單
  - [x] 二進位檔、新增檔、刪除檔、改名不會讓解析崩潰
- **Status**: Completed (`7a90119`..`b5cee35`)

### function-ranges
- **Spec 章節**: 非 JS 語言 / 打勾粒度 — `functions.js`
- **Name**: Function 邊界抽取
- **Scope**: 合約為「吃檔名 + 內容 → 吐 `[{name, startLine, endLine}]`」。JS 檔用 acorn parse，
  只切**最外層具名單位**（內部 callback closure 不另外切）。不認識的副檔名一律回 `[]`。
- **Deps**: none
- **Tier**: 1
- **Touches**: `functions.js`, `test/functions.test.js`
- **Acceptance**:
  - [ ] JS 檔回傳各最外層具名 function 的正確起訖行
  - [ ] 內部 closure / callback 不產生額外項目
  - [ ] `.css` / `.java` / `.jsp` 等未知副檔名回 `[]`
  - [ ] 語法錯誤的 JS 檔不拋例外，降級回 `[]`
  - [ ] 涵蓋 function declaration、`X.prototype.y = function`、class method、
        `const f = () =>` 等具名形式
- **Status**: Pending

### repo-config
- **Spec 章節**: 多 repo 與設定 — `config.js`
- **Name**: Repo 清單設定讀寫
- **Scope**: 讀寫 `~/.local-code-review/config.json` 的 repo 清單，含新增 / 移除 / 列出。
  首次執行自動建立目錄與空設定檔。提供 repo-id 的產生規則供 state 檔命名使用。
- **Deps**: none
- **Tier**: 1
- **Touches**: `config.js`, `test/config.test.js`
- **Acceptance**:
  - [ ] 設定檔不存在時自動建立 `~/.local-code-review/` 與空的 `config.json`
  - [ ] 能新增 / 移除 / 列出 repo
  - [ ] 每個 repo 有穩定的 repo-id（同路徑永遠得到同 id）
  - [ ] 損毀的 config.json 不會讓程式崩潰
- **Status**: Pending

### change-point-model
- **Spec 章節**: 架構 / Pipeline — `model.js` ★核心邏輯，測試重點
- **Name**: 三層樹合成
- **Scope**: 把 diff 的變更行按所在 function 分桶，合成「檔案 → function → 變更點」三層樹。
  同一 function 的多個 hunk **不合併**；橫跨兩個 function 的 hunk **拆成兩個**變更點；
  不在任何 function 內的改動掛在檔案層（非 JS 檔全部走這條路徑）。
- **Deps**: diff-parser, function-ranges
- **Tier**: 2
- **Touches**: `model.js`, `test/model.test.js`
- **Acceptance**:
  - [ ] 同一 function 內三個 hunk → 三個獨立變更點
  - [ ] 橫跨兩個 function 的 hunk → 拆成兩個變更點，各自歸屬正確 function
  - [ ] 不在任何 function 內的改動掛在檔案層
  - [ ] 非 JS 檔（`functions.js` 回 `[]`）自動降級為兩層：檔案 → hunk
  - [ ] 各層有 `已看/總數` 可供加總
- **Status**: Pending

### state-store
- **Spec 章節**: 進度失效規則 — `state.js`
- **Name**: 進度持久化與 content hash 失效
- **Scope**: 以 `hash(檔案路徑 + function 名 + 該變更點的 diff 內容)` 為 key，讀寫
  `~/.local-code-review/state/<repo-id>.json`，把已存的勾與 comment 合併回三層樹。
  變更點消失的 comment 搬到「孤兒」區保留。
- **Deps**: change-point-model
- **Tier**: 2
- **Touches**: `state.js`, `test/state.test.js`
- **Acceptance**:
  - [ ] amend 後行號全變、內容沒變 → 勾保留
  - [ ] 該段 code 真的被改了 → hash 變了，回到未讀
  - [ ] function 改名 → 視為新的變更點（回到未讀）
  - [ ] 變更點消失的 comment 進入孤兒區而非被丟棄
  - [ ] 進度檔寫在 `~/.local-code-review/state/`，不在被 review 專案內
- **Status**: Pending

### export-formats
- **Spec 章節**: 匯出 — `export.js`
- **Name**: Claude prompt 與 Markdown 匯出
- **Scope**: 產出兩種字串格式。Claude prompt 只含**有 comment 的變更點**，每則帶檔案絕對路徑、
  所在 function 的完整原始碼、該變更點 diff、使用者 comment，開頭一句任務描述。
  Markdown 為全量結構化摘要（repo / ref / 日期 / 進度統計 + 逐檔逐 function 的 comment）。
- **Deps**: change-point-model, state-store
- **Tier**: 2
- **Touches**: `export.js`, `test/export.test.js`
- **Acceptance**:
  - [ ] Claude prompt 只包含有 comment 的變更點
  - [ ] 每則帶檔案絕對路徑 + 所在 function 完整原始碼 + diff + comment
  - [ ] Markdown 依 spec 範例的層級結構輸出，含進度統計行
  - [ ] 無 comment 時兩種格式皆能產出合理輸出而不崩潰
- **Status**: Pending

### server-api
- **Spec 章節**: 架構 / API 概要 — `server.js` + `review.js`
- **Name**: HTTP server 與 JSON API
- **Scope**: `node review.js` 啟動、固定 port 7777。實作 spec 的六個 endpoint：
  `/api/repos`、`/api/refs`、`/api/diff`、`/api/check`、`/api/comment`、`/api/export`，
  並提供 `public/` 靜態檔。串接前述所有純邏輯模組。
- **Deps**: state-store, repo-config, export-formats
- **Tier**: 2
- **Touches**: `review.js`, `server.js`, `package.json`, `test/server.test.js`
- **Acceptance**:
  - [ ] `node review.js` 起在 port 7777 並提供 `public/` 靜態檔
  - [ ] 六個 endpoint 皆回傳 spec 描述的資料
  - [ ] `/api/diff` 回傳已合併勾與 comment 的三層樹
  - [ ] `/api/check` 與 `/api/comment` 的變更會持久化
  - [ ] git 指令失敗（如 ref 不存在）回傳可讀錯誤而非 500 stack trace
- **Status**: Pending

### ui-shell-tree
- **Spec 章節**: 畫面 / 版面 — `public/`
- **Name**: 版面骨架、頂列 picker、左樹
- **Scope**: `index.html` / `app.js` / `style.css` 骨架。頂列：repo 下拉、base…target picker
  （target 含特殊項 Working Tree 與變動提示）、unified/side-by-side 切換、總進度。
  左側三層樹含各層 `已看/總數`、子項全勾自動打勾、點擊捲到右側對應處、右側捲動時自動高亮。
- **Deps**: server-api
- **Tier**: 2
- **Touches**: `public/index.html`, `public/app.js`, `public/style.css`
- **Acceptance**:
  - [ ] repo 下拉可切換，切換後重新載入該 repo 的 diff
  - [ ] base / target picker 可選 ref，target 另有 Working Tree 選項
  - [ ] 選 Working Tree 時顯示「diff 會隨編輯而變、勾會失效」提示
  - [ ] 左樹三層正確顯示，各層 `已看/總數` 正確加總
  - [ ] 點左樹捲到右側對應變更點；右側捲動時左樹高亮跟隨
- **Status**: Pending

### diff-render
- **Spec 章節**: 畫面 / 版面 — diff 呈現
- **Name**: Diff 呈現、Prism 上色、雙模式切換
- **Scope**: 右側長捲軸的變更點區塊繪製，含 Prism.js 唯讀語法上色、
  unified 與 side-by-side 兩種呈現一鍵切換、已勾淡化 / 當前高亮的視覺狀態。
- **Deps**: ui-shell-tree
- **Tier**: 2
- **Touches**: `public/app.js`, `public/style.css`, `public/vendor/prism.*`
- **Acceptance**:
  - [ ] 變更點以 unified 正確呈現 `+` / `-` / context
  - [ ] 可一鍵切換 side-by-side，左右對齊正確
  - [ ] Prism 上色套用於 JS，未知語言不崩潰
  - [ ] 已勾的變更點淡化、當前的高亮
- **Status**: Pending

### ui-comments-export
- **Spec 章節**: 畫面 + 匯出 — 前端部分
- **Name**: Comment UI 與匯出按鈕
- **Scope**: 對變更點新增 / 編輯 / 刪除 comment 的介面（`Esc` 取消、`⌘Enter` 存檔），
  孤兒 comment 區的呈現與處置（丟棄 / 保留），以及兩顆匯出按鈕（Claude prompt / Markdown），
  皆複製到剪貼簿並給予複製成功回饋。
- **Deps**: ui-shell-tree
- **Tier**: 2
- **Touches**: `public/app.js`, `public/style.css`
- **Acceptance**:
  - [ ] 可對變更點新增 / 編輯 / 刪除 comment 並持久化
  - [ ] `Esc` 取消編輯、`⌘Enter` 存檔
  - [ ] 孤兒 comment 有專區呈現，可選擇丟棄或保留
  - [ ] 兩顆匯出按鈕皆複製到剪貼簿並顯示成功回饋
- **Status**: Pending

### ui-keyboard-help
- **Spec 章節**: 畫面 / 鍵盤
- **Name**: 鍵盤操作與速查表
- **Scope**: 實作 spec 鍵盤表：`j`/`k`、`x`（勾起來時自動跳下一個、取消勾不跳）、`u`、`c`、`f`、
  `1`/`2`、`?`。`space` 不綁定，保留給瀏覽器捲動。`?` 叫出速查表浮層（`Esc` 關閉），
  角落另有常駐 `?` 按鈕。
- **Deps**: ui-shell-tree
- **Tier**: 2
- **Touches**: `public/app.js`, `public/style.css`
- **Acceptance**:
  - [ ] `j`/`k` 在變更點間移動；`u` 跳到下一個未讀
  - [ ] `x` 勾起來時自動跳下一個，取消勾時不跳
  - [ ] `1`/`2` 切換 unified / side-by-side；`f` 折疊展開 function
  - [ ] `space` 維持瀏覽器捲動行為
  - [ ] `?` 開啟速查表浮層、`Esc` 關閉；角落有常駐 `?` 按鈕
  - [ ] 編輯 comment 時鍵盤快捷鍵不誤觸
- **Status**: Pending

### jarvis-skill
- **Spec 章節**: 定位與啟動 — jarvis skill
- **Name**: jarvis 專案的啟動 skill
- **Scope**: 在 jarvis 專案建立 `local-code-review` skill，記錄啟動指令、port 7777、
  URL，以及怎麼帶使用者到正確的 repo / branch，讓 Claude 之後能代為開啟。
- **Deps**: server-api
- **Tier**: 1
- **Touches**: `~/Desktop/jarvis/.claude/skills/local-code-review/SKILL.md`
- **Acceptance**:
  - [ ] Skill 有正確的 name / description 與觸發語句
  - [ ] 記載啟動指令、port、URL 與專案路徑
  - [ ] 說明如何協助使用者選定 repo 與 base/target ref
- **Status**: Pending

## Summary

| Status | Count |
|--------|-------|
| Pending | 10 |
| In Progress | 0 |
| Completed | 1 |
| Failed | 0 |
| Total | 11 |
