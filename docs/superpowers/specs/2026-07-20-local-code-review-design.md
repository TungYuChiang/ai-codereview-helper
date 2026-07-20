# Local Code Review Tool — 設計規格

> 2026-07-20 定案。合併兩輪 brainstorming 的結論，取代 `~/Desktop/local-code-review-spec.md`。
> 這是實作的唯一需求來源。

## 要解決的問題

公司不用 GitHub，只用 branch 開發。想要 GitHub PR review 那種體驗：
**看過的地方打勾、可以下 comment**，而且中斷後能接著看。

實際情境：一條 fix branch 相對 base branch 有 1300 行改動、集中在兩個大檔，
要逐段讀完並記錄疑問。長期目標是它成為日常 review 的常駐入口，服務多個專案。

## 定位與啟動

| 項目 | 決定 |
|---|---|
| 位置 | `~/Desktop/tools/local-code-review/`，獨立 repo |
| 發佈 | 不發 npm、不做 npx。要在別處用就設 alias |
| 啟動 | `node review.js`，手動起、開著就好 |
| Port | 固定 `7777`，瀏覽器書籤 `localhost:7777` |
| 使用者 | 單人本機。不用登入、不用資料庫、不用多人協作 |
| 前端 | vanilla JS，無框架、無 build step |
| 相依 | `acorn`（function 邊界）、`prismjs`（語法上色）。兩個都零傳遞相依 |

另外在 jarvis 專案寫一份 skill（`local-code-review`），記錄啟動指令、port、
以及怎麼帶使用者到正確的 repo / branch，讓 Claude 之後能代為開啟。

## 多 repo 與設定

常駐一個 port 服務多個專案。UI 最上層下拉切換 repo。

```
~/.local-code-review/
  config.json          repo 清單
  state/<repo-id>.json 每個 repo 的勾選與 comment 進度
```

進度檔放在使用者家目錄，**不在被 review 專案的 git 追蹤範圍內**。

## Ref 選擇

取代原設計的 CLI `--base` 參數。UI 頂列提供 base / target 兩個 picker。

- base：選任一 ref（branch / tag / commit）
- target：選任一 ref，或特殊項 **Working Tree**
- ref↔ref 時：`git diff <base>...<target>`（three-dot，共同祖先起算，PR review 標準語意）
- Working Tree 時：`git diff <base>`（含未 commit 改動）

選 Working Tree 時 diff 會隨編輯而變、勾會失效。這是 content hash 設計的正常行為，
UI 上要有一句提示，不要讓使用者以為是 bug。

## 打勾粒度

| 項目 | 決定 |
|---|---|
| 層級 | **兩層**：Function → 該 function 內每個被修改的地方 |
| 同一 function 的多個 hunk | **不合併**，各自獨立打勾（三個 hunk = 改了三個不同地方，都要確認） |
| 橫跨兩個 function 的 hunk | **拆成兩個**變更點 |
| Function 邊界 | acorn parse 新版檔案，只切**最外層具名單位**（內部 callback closure 不另外切） |

## 非 JS 語言

`functions.js` 的合約：**吃檔名 + 內容，吐 `[{name, startLine, endLine}]`，不認識的副檔名吐 `[]`**。

非 JS 檔（`.css`、`.java`、`.jsp`…）自動降級成兩層：檔案 → hunk。
`model.js` 本來就要處理「不在任何 function 內的改動掛檔案層」，非 JS 檔全部走那條既有路徑，
**零額外程式碼**。

日後要支援 Java，就是新增一個實作同合約的模組，其他模組一行不改。

## 進度失效規則

key = `hash(檔案路徑 + function 名 + 該變更點的 diff 內容)`

- amend 後行號全變、內容沒變 → 勾**保留**
- 那段 code 真的被改了 → hash 變了，回到未讀
- comment 若其變更點消失 → 搬到「孤兒」區，讓使用者決定丟掉或保留
- function 改名 → 視為新的變更點（改名了本來就該重看）

## 架構

### Pipeline

```
git diff <base>...<target>   ← ref 由 UI 決定
        │
        ▼
   git.js       解析 unified diff → 檔案 / hunk / 逐行標記(+ - context)
        │
        ▼
 functions.js   acorn parse 新版檔案 → 每個最外層具名 function 的起訖行
        │       非 JS 檔回空陣列
        ▼
   model.js     把變更行按所在 function 分桶 → 三層樹  ★核心邏輯，測試重點
        │       · 不在任何 function 內的改動 → 掛檔案層的桶
        ▼
   state.js     算 content hash 當 key，合併已存的勾與 comment
        │
        ▼
  server.js     JSON API 給前端
```

### 模組

| 檔案 | 職責 |
|---|---|
| `git.js` | 跑 git、解析 unified diff、列出 refs。純函式，吃字串吐結構 |
| `functions.js` | acorn → function 範圍。未知副檔名回 `[]` |
| `model.js` | 合成三層樹。**核心邏輯，測試重點** |
| `state.js` | 讀寫進度檔、hash 比對、孤兒 comment 處理 |
| `config.js` | repo 清單的讀寫 |
| `export.js` | 產出 Claude prompt / markdown |
| `server.js` | http + JSON endpoints |
| `public/` | `index.html` / `app.js` / `style.css` |

前六個都是純邏輯，不用開瀏覽器就能單元測試。

### API 概要

- `GET /api/repos` — repo 清單
- `GET /api/refs?repo=` — 該 repo 的 branch / tag 清單
- `GET /api/diff?repo=&base=&target=` — 三層樹（含已合併的勾與 comment）
- `POST /api/check` — 勾 / 取消勾單一變更點
- `POST /api/comment` — 寫 / 改 / 刪 comment
- `GET /api/export?repo=&format=claude|markdown` — 回傳字串，前端負責複製到剪貼簿

## 畫面

### 版面

```
┌────────────────────────────────────────────────────────────┐
│ ragic ▾ │ dev … fix/21839 ▾ │ unified | side-by-side │ 4/19 │
├──────────────────┬─────────────────────────────────────────┤
│ ▾ selector.js 3/8│  ┌───────────────────────────┐          │
│   ▾ processMVPF  │  │ +3004..3018            ☑ │ ← 淡化    │
│     +3004..18 ☑  │  └───────────────────────────┘          │
│     +3020..31 ☑  │  ┌───────────────────────────┐          │
│     +3044..50 ☐  │  │ +3020..3031            ☑ │ ← 高亮    │
│   ▸ renderCell   │  │ - if(!mvpf) return;       │          │
│ ▸ util.js   0/4  │  │ + if(!mvpf) return [];    │          │
│ ▸ system.css 0/2 │  │ 💬 回傳型別變了            │          │
└──────────────────┴─────────────────────────────────────────┘
```

- **左**：三層樹（檔案 → function → 變更點），各層顯示 `已看/總數`，子項全勾完該層自動打勾
- **右**：所有變更點排成長捲軸，各自獨立勾選框
- 點左樹 → 右邊捲到該處；右邊捲動 → 左樹自動高亮當前位置
- 已勾的變更點淡化，當前的高亮
- unified / side-by-side 一鍵切換
- 語法上色用 Prism.js，唯讀即可

### 鍵盤

| 鍵 | 動作 |
|---|---|
| `j` / `k` | 下一個 / 上一個變更點 |
| `x` | 勾 / 取消勾（**勾起來時自動跳下一個**，取消勾不跳） |
| `u` | 跳到下一個**未讀**變更點 |
| `c` | 對目前變更點寫 comment（`Esc` 取消，`⌘Enter` 存檔） |
| `f` | 折疊 / 展開目前 function |
| `1` / `2` | unified / side-by-side |
| `?` | 快捷鍵速查表浮層（`Esc` 關閉） |
| `space` | 不綁定，保留給瀏覽器捲動 |

畫面角落放一個常駐的 `?` 按鈕，滑鼠也能叫出速查表。

## 匯出

兩種格式，**都複製到剪貼簿，不寫檔**。

### Claude prompt

只含**有 comment 的變更點**（comment 就是「我有疑問的地方」，正是要交給 Claude 的）。
每則帶：

- 檔案絕對路徑（Claude 才找得到檔案）
- 所在 function 的**完整原始碼**（不只 diff，否則看不出 caller 關係）
- 該變更點的 diff
- 使用者的 comment

開頭一句任務描述。

### Markdown 筆記

全量結構化摘要，供貼進 Obsidian：

```markdown
# Review: ragic  dev...fix/21839
2026-07-20 · 19 個變更點 · 已看 19 · 3 則 comment

## web/sims/js/selector.js
### processMVPF  (+3020..3031)
> - if(!mvpf) return;
> + if(!mvpf) return [];

回傳型別變了，caller 都改到了嗎？
```

## 明確否決過的方案（不要重新提）

- **git 的 `-W` / `--function-context` 自動抓 function** — 實測過，會往上黏到前一個
  function 並把相鄰的全部合併。47 個 hunk 併成 13 個、單一標題下橫跨好幾個 function，
  跟需求相反。git 的 funcname 只是 regex 啟發式，不知道 function 在哪結束。
- **Regex + 大括號計數算邊界** — 不加相依，但 regex literal、字串裡的 `{`、
  巢狀 closure 都可能算錯，而且會靜默漏行。review 工具最不該犯這種錯。
- **CodeMirror** — 是編輯器，對唯讀上色過重。dev 工具也不該耦合到被 review 的產品程式碼。
- **highlight.js**（大一個量級沒比較好）、**Shiki**（要 build step）
- **只用 hunk 當粒度** — 大改寫時一個 hunk 可以有 241 行、橫跨多個 function，等於沒勾到
- **只用檔案當粒度** — 一個檔 1000 行，勾了等於沒勾
- **comment 寫回程式碼變 `// REVIEW:` 註解** — 污染 working tree，容易誤 commit
- **進度綁 commit SHA** — amend 一次就整份白 review
- **進度只存行號** — amend 後靜默錯位，勾會跑到別的 function 上
- **launchd / pm2 常駐** — 手動起就夠，不值得多一個安裝步驟
- **匯出寫檔** — 剪貼簿就夠，寫檔還要管路徑與清理
- **現在就支援 Java function 分層** — tree-sitter 要編譯 native binding，違反零傳遞相依；
  純 JS 的 Java parser 品質參差。等真的需要再說。

## 實作順序建議

1. `git.js` + `functions.js` + `model.js` 與其單元測試（核心，先確定樹是對的）
2. `state.js`（hash 失效規則要有測試涵蓋 amend 情境）
3. `server.js` + 最小 UI（能看到樹、能勾）
4. diff 呈現、Prism 上色、unified / side-by-side
5. comment、鍵盤、速查表
6. `export.js` 兩種格式
7. multi-repo 設定與 ref picker
8. jarvis skill
