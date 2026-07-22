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
- 兩個 picker 都是可打字篩選的 combobox（不是原生 `<select>`），清單依 commit
  日期由新到舊排序並顯示相對時間；打 `25206` 就能把 35 條 branch 縮到一條
- target picker 會把「已經合併進 base」的 branch 移到最下面並淡化，標註
  「已合併 · diff 會是空的」——因為 three-dot diff 對已合併的 target 會是空的，
  這個標記是在講「選了會看不到東西」，不是在講 branch 很舊
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
`functions.js` 本身是 **router**：依副檔名分派給各語言的實作，自己只保留 JS（acorn）那條路。

仍不認識的副檔名（`.css`、`.py`、`.xml`…）自動降級成兩層：檔案 → hunk。
`model.js` 本來就要處理「不在任何 function 內的改動掛檔案層」，這些檔全部走那條既有路徑，
**零額外程式碼**。

已支援的語言：

| 副檔名 | 實作 | 單位 |
|---|---|---|
| `.js` `.mjs` `.cjs` `.jsx` | `functions.js`（acorn） | 最外層具名單位 |
| `.java` | `java.js`（手寫 lexer） | method 與 constructor |
| `.jsp` `.jspf` `.tag` | `java.js`（手寫 lexer） | `<%! %>` 宣告區塊裡的 method |

### 新增語言的成本（實測修正）

原本寫的是「新增一個實作同合約的模組，其他模組一行不改」。**加 Java 時實測，這句話要修正**：

- `model.js`、`git.js`、`state.js`、`server.js`、`public/` —— 確實**一行不改**。
  `model.js` 只吃 `[{name, startLine, endLine}]`，不在乎範圍從哪來；
  `public/state.js` 的 `buildFunctionLabel` 以最後一個 `.` 切前綴/尾巴，
  `Outer.Inner.doThing` 直接沿用 `SelectList.prototype.listAll` 的呈現方式。
- 但 `functions.js` **一定要改**——它是分派點，本來就沒有別的地方可以掛。
  正確說法是：**「新增一個模組 + `functions.js` 一行分派，其餘模組不動」**。
- 另外，`test/functions.test.js` 裡兩條「`.java` / `.jsp` 回 `[]`」的斷言必須改寫。
  那是舊行為的規格，不是意外破壞。

### Java / JSP 的粒度

- **單位是 method 與 constructor，不是 class。** 「最外層具名單位」照字面套到 Java
  會得到 class，也就是整個檔案，正好落回下面否決過的「只用檔案當粒度」。
- **名字帶上外層 class 鏈**：`Outer.Inner.doThing`。巢狀 / 內部類別的 method 是各自獨立的單位。
- **匿名類別、lambda、enum 常數的 body、method 內的 local class 都不另外切**，
  歸屬外層 method——對應 JS 版「內部 callback closure 不另外切」。
- **field、import、static / instance initializer、class 層 javadoc 與 annotation**
  落到檔案層的桶。initializer block 沒有名字，硬給一個（`Outer.static`）等於發明資訊；
  一個 class 通常也只有一兩個，落檔案層的代價很小。
- **JSP 只切 `<%! %>` 宣告區塊裡的 method。** scriptlet `<% %>`、expression、directive、
  EL、taglib、純 HTML 一律落檔案層——scriptlet 不是具名單位，替它掰名字比沒有名字更糟。

### Fail closed

`java.js` **永不 throw**。大括號不平衡、字串沒收尾、遇到沒預期的構造 —— 一律回 `[]`，
讓該檔降級回「檔案 → hunk」。**錯的範圍比沒有範圍糟糕得多**：它會把改動靜默掛到別的
method 上，而整個進度追蹤設計的前提就是變更點被正確識別。

已知且刻意不處理（`java.js` 檔頭有完整列表）：Java 規範要求 `\uXXXX` 在 lex 之前先展開，
本模組不做這層；record 的 compact constructor（無參數列）不視為單位。兩者都是 fail closed
或漏切，不會產生錯的範圍。

## 進度失效規則

key = `hash(檔案路徑 + function 名 + 該變更點的 diff 內容 + 同桶內出現序號)`

前三項決定「這是不是同一處改動」，第四項處理同一 function 內出現兩處**內容完全
相同**的改動（例如同一組 `-old/+new` 重複兩次）。少了序號，兩個變更點會算出同一個
key，勾其中一個會讓另一個也顯示已讀——使用者沒看過的程式碼被標記成看過，而且是
靜默的。序號依樹的順序計算（檔案 → group → 變更點），因此行號位移時序號不變，
不影響下列任何一條。

- amend 後行號全變、內容沒變 → 勾**保留**
- 那段 code 真的被改了 → hash 變了，回到未讀
- comment 若其變更點消失 → 搬到「孤兒」區，讓使用者決定丟掉或保留
- function 改名 → 視為新的變更點（改名了本來就該重看）

**已知限制**：序號在插入時會位移。若在某個重複內容的更前面插入了新的同內容變更點，
已勾的標記會遷移到另一個實體上，真正被審過的那個回到未讀。觸發條件複合（需先存在
位元組相同的重複內容，再有一次編輯在更前面插入同樣內容），且丟失的勾 fail-closed。
任何純序號方案都無法對插入免疫——要根治得存穩定 id（會破壞 amend 存活，那正是本
設計的目的）或把周邊 context 納入 hash。

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
- `GET /api/refs?repo=` — 該 repo 的 branch / tag 清單，每筆為 `{ name, date }`，
  依 commit 日期由新到舊排序（`git for-each-ref`，不是字母序）
- `GET /api/merged?repo=&base=` — 已合併進 `base` 的 branch 名稱。因為
  「已合併」是 (ref, base) 的性質，換 base 就會失效，所以獨立成一支 API
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
- ~~**現在就支援 Java function 分層** — tree-sitter 要編譯 native binding，違反零傳遞相依；
  純 JS 的 Java parser 品質參差。等真的需要再說。~~
  **2026-07-22 解除**（原文保留，理由本身沒有錯，見下方 amendment）。

## 實作順序建議

1. `git.js` + `functions.js` + `model.js` 與其單元測試（核心，先確定樹是對的）
2. `state.js`（hash 失效規則要有測試涵蓋 amend 情境）
3. `server.js` + 最小 UI（能看到樹、能勾）
4. diff 呈現、Prism 上色、unified / side-by-side
5. comment、鍵盤、速查表
6. `export.js` 兩種格式
7. multi-repo 設定與 ref picker
8. jarvis skill

---

## Amendment 2026-07-22：Java / JSP function 分層

> 草案。修改「非 JS 語言」一節與「明確否決過的方案」裡的 Java 條目。

### 為什麼原本否決，以及什麼變了

原本的理由是：

> tree-sitter 要編譯 native binding，違反零傳遞相依；純 JS 的 Java parser 品質參差。
> 等真的需要再說。

**這段推理沒有錯，而且限制也沒有放寬**——本專案至今仍只有 `acorn` 與 `prismjs`
兩個零傳遞相依的套件，tree-sitter 依然不能用，npm 上的純 JS Java parser 依然不敢信。
原文因此保留在否決清單裡，不刪除。

變的是兩件事：

1. **當時預設了「支援 Java＝引入一個 Java parser」。** 這個前提是錯的。
   我們不需要 parse Java，只需要知道**每個 method body 從第幾行到第幾行**。
   那不需要型別系統、不需要泛型推導、不需要 AST，只需要一個
   **能正確處理註解、字串、char literal 與 text block 的 tokenizer**，再在
   token 流上數大括號。手寫 lexer 約 400 行、**零相依**，正面滿足原本的約束，
   而不是繞過它。
2. **「等真的需要再說」的條件已經到了。** 使用者的公司程式碼以 Java 與 JSP 為主，
   一個 1000 行的 Java 檔目前塌成幾個大 hunk，勾一個等於沒勾——這正是規格自己
   在否決清單裡寫的「只用檔案當粒度：一個檔 1000 行，勾了等於沒勾」。
   不做 Java 分層，這個工具對它主要的使用情境是失效的。

### 這不是被否決過的「regex + 大括號計數」

否決清單裡還有一條：

> **Regex + 大括號計數算邊界** — 不加相依，但 regex literal、字串裡的 `{`、
> 巢狀 closure 都可能算錯，而且會靜默漏行。review 工具最不該犯這種錯。

**這條依然成立，而且正是這次實作要避開的東西。** tokenizer 與 regex 是兩件事：
regex 是在字元流上比對形狀，字串與註解的內容會直接污染大括號深度；tokenizer 是
**先把註解丟掉、把每個字面值收斂成單一 token**，之後數大括號時深度由建構保證精確
——字串裡的 `{` 在 token 流裡根本不存在。

再加上 fail-closed：任何算不出來的情況一律回 `[]`，退回今天的行為。
否決那條的核心顧慮是「靜默算錯」，這裡用「算不出來就承認算不出來」正面回應。

### 決定摘要

見上方「非 JS 語言」一節（單位、命名、fail closed、新增語言的實際成本）。
