# java-jsp-function-ranges（使用者追加需求）

2026-07-22 · 未 commit（交由使用者 session review 後入庫）

## 起因

使用者的公司程式碼以 Java 與 JSP 為主，而 `.java` / `.jsp` 至今沒有 function 分層：
一個 1000 行的 Java 檔塌成幾個大 hunk，勾一個等於沒勾——正是規格自己在否決清單裡
寫的「只用檔案當粒度」那種失敗。

規格原本把 Java 分層列在「明確否決過的方案」，理由是 tree-sitter 要編譯 native
binding、純 JS Java parser 品質參差。這次沒有放寬那個限制，而是換掉前提：
**我們不需要 parse Java，只需要知道每個 method body 從第幾行到第幾行。**

## 成果

新模組 `java.js`（零相依，手寫 lexer + 遞迴下降）：

- `getJavaFunctionRanges(content)` — 單位是 **method 與 constructor**，
  名字帶外層 class 鏈（`Outer.Inner.doThing`）。
- `getJspFunctionRanges(content)` — **只有** `<%! %>` 宣告區塊裡的 method 成為範圍。

`functions.js` 轉成純 router，依副檔名分派（`.java` / `.jsp` / `.jspf` / `.tag`）。

### 為什麼是 lexer 不是 regex

規格否決過「regex + 大括號計數」，因為字串、註解、字元常值裡的 `{` 會讓深度算錯
而且靜默漏行。tokenizer 是不同的東西：先把註解丟掉、把每個字面值（字串 / char /
text block）收斂成**單一 token**，之後在 token 流上數大括號，深度由建構保證精確
——字串裡的 `{` 在 token 流裡根本不存在。

### method body 的判準

一個 `{` 是 method body ⟺ 這個成員宣告的最外層先出現過一組 `( ... )`（參數列）、
在那之前沒有 `=`、之後沒有 `default`。這一條同時擋掉：

- `private int[] x = {1, 2, 3};` — 沒有參數列，`{` 是陣列初始值
- `private Runnable r = new Runnable() { ... };` — 有 `=`，匿名類別不切
- `void m();` — 遇到 `;` 收工，abstract / interface 宣告不產生範圍
- `String[] tags() default {};` — `default` 擋下來

### Fail closed

`java.js` 永不 throw。大括號不平衡、字串沒收尾、遇到沒預期的構造 —— 一律回 `[]`，
該檔降級回「檔案 → hunk」。錯的範圍會把改動靜默掛到別的 method 上，比沒有範圍糟糕得多。

## 修改的檔案

- `java.js`（新增）
- `functions.js`（改成 router；抽出 `extensionOf`）
- `test/java.test.js`（新增，56 條）
- `test/fixtures/Sample.java`、`test/fixtures/sample.jsp`（新增）
- `test/functions.test.js`（兩條「`.java` / `.jsp` 回 `[]`」的舊斷言改寫成 router 斷言）
- `docs/superpowers/specs/2026-07-20-local-code-review-design.md`（amendment 草案）

## 測試結果

`npm test` → **405 pass / 0 fail**。

原本 348 條中有 346 條原封不動；剩下 2 條是「`.java` / `.jsp` 回 `[]`」——那是舊行為的
規格，改寫成「router 有分派出去」的斷言，並另加 1 條「其他非 JS 副檔名仍回 `[]`」。
加上 `test/java.test.js` 的 56 條，共 405。

### 反向驗證（本專案被燒過四次的地方）

每條測試都用「把對應邏輯拿掉 / 弄壞，確認變紅，再還原」的方式驗過。
跑了 24 個 mutation，其中 **6 個一開始是綠的**，逐一處理：

| Mutation | 原始結果 | 處置 |
|---|---|---|
| lexer 不對未收尾字串報錯 | 綠（被後續的大括號檢查遮住） | 換成「整個字串處理拿掉」才是有效 mutation |
| `!sawEquals` 只拿掉一處 | 綠 | 兩處互為冗餘，**刪掉沒有測試能證明的那一處** |
| enum 常數不跳過 | 綠 | 補測試：沒有成員區段的 enum（`enum E { A { ... } }`）會讓整份 fail closed |
| `NON_NAME_KEYWORDS` 清空 | 綠（mutation 本身寫錯） | 改對後變紅：會生出 `Foo.if` 這種錯範圍，補測試 |
| `Foo.class` 的 `.` 防禦 | 綠（形狀檢查已擋下，不可達） | **刪掉死程式碼**，在註解說明形狀檢查已足夠 |
| 拿掉排序 | 綠 | Java 天生由上而下產出，排序是合約保證而非修正；在測試裡註明沒有輸入能讓它變紅 |

其餘 18 個 mutation 都如預期變紅（無字串 lexing、無註解處理、無 text block、
無 try/catch、少 `default` 判斷、compilation-unit 大括號檢查、`skipBalanced`
不報錯、JSP 把所有 `<%` 當宣告、JSP 丟掉行號位移、JSP 用單純 `indexOf('%>')`、
JSP 忽略 `<%--`、static initializer 當成成員、class 鏈前綴拿掉、annotation 不跳過、
修飾字不跳過、JSP 容忍多餘 `}` …）。

### 端對端

另建合成 repo（`/tmp/agent-java`）+ 隔離 `LCR_HOME`，開在 **port 7796**（沒有碰 7777）。
確認 `GET /api/diff` 與畫面：

```
FILE src/Service.java
   group: <file-level>        cps: 6..10     ← 新增的 field，如設計落在檔案層
   group: Service.run         cps: 22..26
   group: Service.Helper.other cps: 41..43   ← 內部類別的 method 各自成單位
FILE web/page.jsp
   group: total               cps: 15..21    ← <%! %> 裡的 method，行號是全檔行號
```

左樹每個 method 一組，`Service.` 前綴淡化、`run` 尾巴高亮（`buildFunctionLabel`
不用改就吃得下三段式名稱）。Prism 的 java 上色與「全部 (N 行)」展開整個 function
也都正常。

## 備註

### 規格那句「其他模組一行不改」需要修正

實測：`model.js`、`git.js`、`state.js`、`server.js`、`public/` 確實一行不改。
但 `functions.js` **一定要改**——它是分派點。正確說法是
「新增一個模組 + `functions.js` 一行分派」。已在 amendment 裡改掉。

### 刻意不處理（`java.js` 檔頭有列）

- Java 規範要求 `\uXXXX` 在 lex 之前先展開；本模組不做這層。真的遇到會因為
  大括號不平衡而 fail closed，不會產生錯的範圍。
- record 的 compact constructor（`Point { ... }`，沒有參數列）不視為單位，落檔案層。
- method body 內的 local class、匿名類別、lambda 的 method 都不另外切（與 JS 版一致）。
- JSP：Java 字串裡未跳脫的 `%>` **不會**提前收尾（比 JSP 規範寬鬆，但符合真實碼）。
  `<%--%>` 註解與 `<%@` directive 用單純字串搜尋找結尾，因為 directive 的屬性值
  可以用單引號，拿 Java 的 char literal 規則去讀會誤判成未收尾。
