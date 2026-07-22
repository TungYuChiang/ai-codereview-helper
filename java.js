// java.js — Java / JSP 的「函式邊界」抽取器。零相依，手寫 lexer + 遞迴下降。
//
// 對外合約與 functions.js 相同：吃內容吐 [{name, startLine, endLine}]，
// **永不 throw**。任何看不懂的東西一律回 []，讓該檔降級成「檔案 → hunk」兩層。
// 這是刻意的 fail-closed：錯的範圍會把改動靜默掛到別的 method 上，比沒有範圍糟糕得多。
//
// 為什麼是 lexer 不是 regex：規格否決過「regex + 大括號計數」，因為字串、註解、
// 字元常值裡的 `{` 會讓深度算錯而且靜默漏行。先 tokenize（註解丟掉、字串/字元/
// text block 各自收斂成一個 token），再在 token 流上數大括號，深度就是精確的。
//
// 粒度決定（規格 amendment 有完整說明）：
//   · 單位是 method 與 constructor，不是 class。class 當單位＝整個檔案，等於沒切。
//   · 名字帶上外層 class 鏈：Outer.Inner.doThing（分隔符用 `.`，
//     public/state.js 的 buildFunctionLabel 以最後一個 `.` 切前綴/尾巴）。
//   · 匿名類別、lambda、enum 常數的 body、method 內的 local class 都**不另外切**，
//     歸屬於外層 method（對應 JS 版「內部 callback closure 不另外切」）。
//   · field、import、static/instance initializer、class 層 javadoc 與 annotation
//     都不產生範圍，落到 model.js 既有的檔案層桶。
//
// 已知限制（刻意不處理）：
//   · Java 規範要求在 lex 之前先展開 `\uXXXX` escape，所以理論上 `{` 等同一個
//     真的 `{`。本模組不做這層展開；原始碼裡的 `{` 才算 `{`。真實程式碼幾乎不會這樣寫，
//     真的遇到會因為大括號不平衡而 fail closed 回 []，不會產生錯的範圍。
//   · record 的 compact constructor（`Point { ... }`，沒有參數列）不視為單位，
//     落到檔案層。它與「沒有參數列就不是 method body」的判準衝突，寧可漏不要錯。
//   · method body 內的 local class / 匿名類別的 method 不另外切（見上）。

const TYPE_DECL_KEYWORDS = new Set(['class', 'interface', 'enum', 'record']);

// 這些關鍵字不可能是 method 名字。用來擋掉「`(` 前一個 token 是 id」的誤判，
// 例如 `if (`、`while (`、`synchronized (`、`switch (`。
const NON_NAME_KEYWORDS = new Set([
  'if',
  'while',
  'for',
  'switch',
  'catch',
  'synchronized',
  'return',
  'new',
  'assert',
  'do',
  'else',
  'try',
  'throw',
  'instanceof',
  'case',
  'yield',
]);

/** 內部用的失敗訊號；一律在對外函式邊界被吃掉並轉成 []。 */
class GiveUp extends Error {}

// ---------------------------------------------------------------------------
// 對外入口
// ---------------------------------------------------------------------------

/** @returns {{name: string, startLine: number, endLine: number}[]} */
export function getJavaFunctionRanges(content) {
  try {
    const tokens = tokenize(content, 0);
    const ranges = [];
    parseCompilationUnit(tokens, ranges);
    return sortRanges(ranges);
  } catch {
    return [];
  }
}

/**
 * JSP：**只有** `<%! ... %>` 宣告區塊裡的 method 會變成範圍。
 * scriptlet `<% %>`、expression `<%= %>`、directive `<%@ %>`、EL、taglib、純 HTML
 * 都落到檔案層——scriptlet 不是具名單位，硬掰名字比沒有名字更糟。
 */
export function getJspFunctionRanges(content) {
  try {
    const ranges = [];
    for (const block of extractDeclarationBlocks(content)) {
      const tokens = tokenize(block.text, block.startLine - 1);
      // 宣告區塊的內容就是 class body 的成員列表，只是沒有外層 class，
      // 因此 prefix 為空、終止條件是「token 用完」而不是 `}`。
      parseMembers(tokens, 0, '', ranges, null);
    }
    return sortRanges(ranges);
  } catch {
    return [];
  }
}

function sortRanges(ranges) {
  return ranges.sort((a, b) => a.startLine - b.startLine);
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

const ID_START = /[\p{L}_$]/u;
const ID_PART = /[\p{L}\p{Nd}_$]/u;

/**
 * 把 Java 原始碼切成 token。註解直接丟掉；字串 / 字元 / text block 各自收斂成
 * 一個 token，所以之後在 token 流上數大括號時，字面值裡的 `{` 不可能干擾深度。
 *
 * @param {string} src
 * @param {number} lineOffset 產出的 line 會加上這個位移（JSP 把區塊拆出來單獨 lex 用）
 * @returns {{kind: 'id'|'num'|'lit'|'punct', value: string, line: number}[]}
 * @throws {GiveUp} 未收尾的字串 / 字元 / 註解 / text block
 */
function tokenize(src, lineOffset) {
  const tokens = [];
  let i = 0;
  let line = 1 + lineOffset;
  const n = src.length;

  while (i < n) {
    const ch = src[i];

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f') {
      i++;
      continue;
    }

    // 註解 —— 內容完全不看，裡面的 `{`、`"`、`'` 都不算數。
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new GiveUp('unterminated block comment');
      line += countNewlines(src, i, end + 2);
      i = end + 2;
      continue;
    }

    // Text block（Java 15+）：""" ... """，裡面可以有 "、{、// 等任何東西。
    if (ch === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      const startLine = line;
      let p = i + 3;
      for (;;) {
        if (p >= n) throw new GiveUp('unterminated text block');
        if (src[p] === '\\') {
          if (src[p + 1] === '\n') line++;
          p += 2;
          continue;
        }
        if (src[p] === '\n') {
          line++;
          p++;
          continue;
        }
        if (src[p] === '"' && src[p + 1] === '"' && src[p + 2] === '"') {
          p += 3;
          break;
        }
        p++;
      }
      tokens.push({ kind: 'lit', value: '"""', line: startLine });
      i = p;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const startLine = line;
      let p = i + 1;
      for (;;) {
        if (p >= n || src[p] === '\n') throw new GiveUp('unterminated literal');
        if (src[p] === '\\') {
          p += 2;
          continue;
        }
        if (src[p] === ch) {
          p++;
          break;
        }
        p++;
      }
      tokens.push({ kind: 'lit', value: ch, line: startLine });
      i = p;
      continue;
    }

    // 數字：只要把它整團吃掉即可，內容不重要。開頭是數字就進來，
    // 這樣 `0x7B`、`1_000`、`3.14f` 都不會被拆出奇怪的 token。
    if (ch >= '0' && ch <= '9') {
      let p = i;
      while (p < n && (ID_PART.test(src[p]) || src[p] === '.')) p++;
      tokens.push({ kind: 'num', value: src.slice(i, p), line });
      i = p;
      continue;
    }

    if (ID_START.test(ch)) {
      let p = i;
      while (p < n && ID_PART.test(src[p])) p++;
      tokens.push({ kind: 'id', value: src.slice(i, p), line });
      i = p;
      continue;
    }

    // 其餘一律當單字元標點。解析階段只在意 { } ( ) ; = @ . < >，
    // 其他運算子拆成幾個 token 都無所謂。
    tokens.push({ kind: 'punct', value: ch, line });
    i++;
  }

  return tokens;
}

function countNewlines(str, from, to) {
  let count = 0;
  for (let i = from; i < to; i++) {
    if (str[i] === '\n') count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Parser（在 token 流上跑，深度由建構保證精確）
// ---------------------------------------------------------------------------

function isPunct(token, value) {
  return token !== undefined && token.kind === 'punct' && token.value === value;
}

function isId(token, value) {
  return token !== undefined && token.kind === 'id' && token.value === value;
}

/**
 * compilation unit：package / import / annotation / 型別宣告。
 * 這一層出現 `{` 或 `}` 就代表這不是我們看得懂的 Java（例如副檔名是 .java
 * 但內容其實是 JS），直接放棄。
 */
function parseCompilationUnit(tokens, ranges) {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];

    if (isPunct(token, '{') || isPunct(token, '}')) {
      throw new GiveUp('brace at compilation-unit level');
    }

    if (isPunct(token, '@')) {
      if (isId(tokens[i + 1], 'interface')) {
        i = parseTypeDecl(tokens, i, '', ranges);
        continue;
      }
      i = skipAnnotation(tokens, i);
      continue;
    }

    if (isTypeDeclStart(tokens, i)) {
      i = parseTypeDecl(tokens, i, '', ranges);
      continue;
    }

    i++;
  }
}

/**
 * `class` / `interface` / `enum` / `record` 只有在「後面接一個識別字、再後面是
 * 型別宣告 header 會出現的符號」時才算宣告開頭。
 * `record` 在 Java 裡是 contextual keyword，這道形狀檢查同時擋掉它當變數名的情況；
 * `Foo.class` 也被同一道檢查擋下（`class` 後面接的是 `;` 或 `)`，不是識別字），
 * 所以不需要另外判斷前一個 token 是不是 `.`。
 */
function isTypeDeclStart(tokens, i) {
  const token = tokens[i];
  if (token.kind !== 'id' || !TYPE_DECL_KEYWORDS.has(token.value)) return false;

  const name = tokens[i + 1];
  if (name === undefined || name.kind !== 'id') return false;

  const after = tokens[i + 2];
  if (after === undefined) return false;
  if (isPunct(after, '{') || isPunct(after, '<') || isPunct(after, '(')) return true;
  return (
    after.kind === 'id' &&
    (after.value === 'extends' || after.value === 'implements' || after.value === 'permits')
  );
}

/**
 * 解析一個型別宣告，回傳「closing `}` 之後」的索引。
 * header（泛型、extends、implements、record 參數列）直接掃到第一個 `{` 為止 ——
 * 這些語法都不可能含 `{`。
 */
function parseTypeDecl(tokens, start, prefix, ranges) {
  let i = start;
  let isEnum = false;

  if (isPunct(tokens[i], '@')) {
    i += 2; // @interface
  } else {
    isEnum = tokens[i].value === 'enum';
    i += 1;
  }

  const nameToken = tokens[i];
  if (nameToken === undefined || nameToken.kind !== 'id') throw new GiveUp('type has no name');
  const qualified = prefix === '' ? nameToken.value : `${prefix}.${nameToken.value}`;
  i++;

  while (i < tokens.length && !isPunct(tokens[i], '{')) {
    if (isPunct(tokens[i], ';') || isPunct(tokens[i], '}')) throw new GiveUp('type has no body');
    i++;
  }
  if (i >= tokens.length) throw new GiveUp('type has no body');

  i += 1; // 越過 `{`

  if (isEnum) i = skipEnumConstants(tokens, i);

  return parseMembers(tokens, i, qualified, ranges, '}');
}

/**
 * enum 常數列表：吃到 `;`（後面接一般成員）或直接遇到 `}`（沒有成員）。
 * 常數的 body（`A { void m() {} }`）在 JLS 裡就是匿名類別 body，
 * 依「匿名類別不另外切」的規則整團跳過，落到檔案層。
 */
function skipEnumConstants(tokens, start) {
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i];
    if (isPunct(token, '}')) return i;
    if (isPunct(token, ';')) return i + 1;
    if (isPunct(token, '(')) {
      i = skipBalanced(tokens, i, '(', ')');
      continue;
    }
    if (isPunct(token, '{')) {
      i = skipBalanced(tokens, i, '{', '}');
      continue;
    }
    if (isPunct(token, '@')) {
      i = skipAnnotation(tokens, i);
      continue;
    }
    i++;
  }
  throw new GiveUp('unterminated enum body');
}

/**
 * 逐一解析 class body 的成員。
 *
 * @param {string|null} terminator '}' = 讀到對應的右大括號為止（一般 class body）；
 *        null = 讀到 token 用完為止（JSP `<%! %>` 宣告區塊，沒有外層 class）。
 * @returns 終止位置之後的索引
 */
function parseMembers(tokens, start, prefix, ranges, terminator) {
  let i = start;

  for (;;) {
    if (i >= tokens.length) {
      if (terminator === null) return i;
      throw new GiveUp('unterminated class body');
    }

    const token = tokens[i];

    if (isPunct(token, '}')) {
      if (terminator === '}') return i + 1;
      throw new GiveUp('unexpected closing brace');
    }

    if (isPunct(token, ';')) {
      i++; // 多餘的分號
      continue;
    }

    if (isPunct(token, '@')) {
      if (isId(tokens[i + 1], 'interface')) {
        i = parseTypeDecl(tokens, i, prefix, ranges);
        continue;
      }
      i = skipAnnotation(tokens, i);
      continue;
    }

    // static initializer：只有 `static` 緊接著 `{` 才是（`static void m()` 不是）。
    if (isId(token, 'static') && isPunct(tokens[i + 1], '{')) {
      i = skipBalanced(tokens, i + 1, '{', '}');
      continue;
    }

    // instance initializer
    if (isPunct(token, '{')) {
      i = skipBalanced(tokens, i, '{', '}');
      continue;
    }

    // 巢狀 / 內部型別宣告。修飾字（`static class Inner`、`private enum Kind`）
    // 要先跳過才看得到關鍵字，否則會被當成一般成員宣告解析而撞牆。
    const typeStart = typeDeclStartAfterModifiers(tokens, i);
    if (typeStart !== -1) {
      i = parseTypeDecl(tokens, typeStart, prefix, ranges);
      continue;
    }

    i = parseMemberDeclaration(tokens, i, prefix, ranges);
  }
}

/** 成員宣告可以帶的修飾字。只用來「跳過」，本身不影響任何判斷。 */
const MODIFIERS = new Set([
  'public',
  'protected',
  'private',
  'static',
  'final',
  'abstract',
  'native',
  'synchronized',
  'transient',
  'volatile',
  'strictfp',
  'default',
  'sealed',
  'non', // non-sealed 會被 lexer 拆成 non / - / sealed
]);

/**
 * 從 start 跳過修飾字後，若接著是型別宣告就回傳該關鍵字的索引，否則回傳 -1。
 * @returns {number}
 */
function typeDeclStartAfterModifiers(tokens, start) {
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.kind === 'id' && MODIFIERS.has(token.value)) {
      i++;
      continue;
    }
    if (isPunct(token, '-') && isId(tokens[i - 1], 'non')) {
      i++;
      continue;
    }
    break;
  }

  if (i >= tokens.length) return -1;
  if (isPunct(tokens[i], '@') && isId(tokens[i + 1], 'interface')) return i;
  if (isTypeDeclStart(tokens, i)) return i;
  return -1;
}

/**
 * 解析一個 field / method / constructor 宣告，回傳其後的索引；是 method 或
 * constructor 才推一筆範圍。
 *
 * 判準：在宣告的最外層先看到一組 `( ... )`（＝參數列）、而且在那之前沒有 `=`、
 * 之後沒有 `default`，那麼接下來的 `{` 才是 method body。
 *   · `private int[] x = {1,2,3};` —— 先看到 `=`，`{` 是陣列初始值，不是 body
 *   · `private Runnable r = new Runnable() { ... };` —— 同上，匿名類別不切
 *   · `void m();`（abstract / interface 宣告）—— 遇到 `;` 就結束，不產生範圍
 *   · `String[] tags() default {};`（annotation element）—— `default` 擋下來
 * method 名字取「參數列左括號的前一個識別字」，泛型簽章 `<T ...> void sort(...)`
 * 與 constructor `Foo(int x)` 都自然落在這個位置。
 */
function parseMemberDeclaration(tokens, start, prefix, ranges) {
  let i = start;
  let sawParams = false;
  let sawEquals = false;
  let sawDefault = false;
  let methodName = null;

  while (i < tokens.length) {
    const token = tokens[i];

    if (isPunct(token, '(')) {
      // 這裡刻意不看 sawEquals：`= new Runnable()` 也會把 methodName 設成
      // `Runnable`，但下面 `{` 的判斷有 `!sawEquals` 擋著，不會產出範圍。
      // 兩處都擋是同一件事擋兩次，任何一處被拿掉測試都照過 —— 留一處就好。
      if (!sawParams) {
        const previous = tokens[i - 1];
        if (
          previous !== undefined &&
          previous.kind === 'id' &&
          !NON_NAME_KEYWORDS.has(previous.value)
        ) {
          methodName = previous.value;
        }
        sawParams = true;
      }
      i = skipBalanced(tokens, i, '(', ')');
      continue;
    }

    if (isPunct(token, '=')) {
      sawEquals = true;
      i++;
      continue;
    }

    if (sawParams && isId(token, 'default')) {
      sawDefault = true;
      i++;
      continue;
    }

    if (isPunct(token, ';')) return i + 1;

    if (isPunct(token, '@')) {
      i = skipAnnotation(tokens, i);
      continue;
    }

    if (isPunct(token, '{')) {
      const after = skipBalanced(tokens, i, '{', '}');
      if (sawParams && !sawEquals && !sawDefault && methodName !== null) {
        ranges.push({
          name: prefix === '' ? methodName : `${prefix}.${methodName}`,
          startLine: tokens[start].line,
          endLine: tokens[after - 1].line,
        });
        return after;
      }
      i = after;
      continue;
    }

    // 成員還沒收尾就撞到 class body 的 `}`：語法不對，放棄整份。
    if (isPunct(token, '}')) throw new GiveUp('unterminated member declaration');

    i++;
  }

  throw new GiveUp('unterminated member declaration');
}

/** `@Foo` / `@a.b.Foo` / `@Foo({...})`：回傳 annotation 之後的索引。 */
function skipAnnotation(tokens, start) {
  let i = start + 1;
  if (tokens[i] === undefined || tokens[i].kind !== 'id') throw new GiveUp('bad annotation');
  i++;
  while (isPunct(tokens[i], '.') && tokens[i + 1] !== undefined && tokens[i + 1].kind === 'id') {
    i += 2;
  }
  if (isPunct(tokens[i], '(')) i = skipBalanced(tokens, i, '(', ')');
  return i;
}

/** tokens[start] 必須是 open；回傳對應 close 之後的索引。深度精確，因為字面值已收斂成單一 token。 */
function skipBalanced(tokens, start, open, close) {
  if (!isPunct(tokens[start], open)) throw new GiveUp('expected ' + open);
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (isPunct(tokens[i], open)) depth++;
    else if (isPunct(tokens[i], close)) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new GiveUp('unbalanced ' + open + close);
}

// ---------------------------------------------------------------------------
// JSP：抽出 `<%! ... %>` 宣告區塊
// ---------------------------------------------------------------------------

/**
 * 掃過整份 JSP，回傳每個宣告區塊的內容與**在原檔的起始行**。
 * 行號位移一定要加回去，否則範圍會靜默指到別的地方 —— 那正是 fail-closed
 * 規則要防的錯誤。
 *
 * 關於 `%>`：JSP 規範要求 Java 字串裡的 `%>` 要寫成 `%\>`，但真實程式碼常常沒遵守。
 * 這裡對 `<%`、`<%=`、`<%!` 三種 Java 內容的區塊採用「Java-aware 找結尾」：
 * 跳過字串 / 字元 / 註解後才認 `%>`，所以未跳脫的 `%>` 也不會提前收尾
 * （比規範寬鬆，但符合真實碼）。`%\>` 因為在字串裡被當成一個 escape，同樣沒事。
 * `<%--` 註解與 `<%@` directive 則用單純的字串搜尋 —— directive 的屬性值可以用
 * 單引號，拿 Java 的 char literal 規則去讀會誤判成未收尾。
 */
function extractDeclarationBlocks(content) {
  const blocks = [];
  let i = 0;
  let line = 1;
  const n = content.length;

  while (i < n) {
    if (content[i] === '\n') {
      line++;
      i++;
      continue;
    }

    if (content.startsWith('<%--', i)) {
      const end = content.indexOf('--%>', i + 4);
      if (end === -1) throw new GiveUp('unterminated JSP comment');
      line += countNewlines(content, i, end + 4);
      i = end + 4;
      continue;
    }

    if (content.startsWith('<%@', i)) {
      const end = content.indexOf('%>', i + 3);
      if (end === -1) throw new GiveUp('unterminated JSP directive');
      line += countNewlines(content, i, end + 2);
      i = end + 2;
      continue;
    }

    if (content.startsWith('<%', i)) {
      const isDeclaration = content[i + 2] === '!';
      const bodyStart = isDeclaration || content[i + 2] === '=' ? i + 3 : i + 2;
      const end = findJavaAwareClose(content, bodyStart);

      if (isDeclaration) {
        blocks.push({ text: content.slice(bodyStart, end), startLine: line });
      }

      line += countNewlines(content, i, end + 2);
      i = end + 2;
      continue;
    }

    i++;
  }

  return blocks;
}

/**
 * 從 from 開始找 `%>`，但跳過 Java 的註解與字面值。
 * @returns `%>` 的索引
 * @throws {GiveUp} 找不到結尾，或途中有未收尾的字面值 / 註解
 */
function findJavaAwareClose(content, from) {
  let i = from;
  const n = content.length;

  while (i < n) {
    if (content.startsWith('//', i)) {
      const nl = content.indexOf('\n', i);
      // 行註解到行尾為止；沒有換行代表檔案結束 —— 那就沒有結尾了。
      if (nl === -1) throw new GiveUp('unterminated JSP block');
      i = nl + 1;
      continue;
    }
    if (content.startsWith('/*', i)) {
      const end = content.indexOf('*/', i + 2);
      if (end === -1) throw new GiveUp('unterminated block comment');
      i = end + 2;
      continue;
    }
    if (content.startsWith('"""', i)) {
      let p = i + 3;
      for (;;) {
        if (p >= n) throw new GiveUp('unterminated text block');
        if (content[p] === '\\') {
          p += 2;
          continue;
        }
        if (content.startsWith('"""', p)) {
          p += 3;
          break;
        }
        p++;
      }
      i = p;
      continue;
    }
    if (content[i] === '"' || content[i] === "'") {
      const quote = content[i];
      let p = i + 1;
      for (;;) {
        if (p >= n || content[p] === '\n') throw new GiveUp('unterminated literal');
        if (content[p] === '\\') {
          p += 2;
          continue;
        }
        if (content[p] === quote) {
          p++;
          break;
        }
        p++;
      }
      i = p;
      continue;
    }
    if (content.startsWith('%>', i)) return i;
    i++;
  }

  throw new GiveUp('unterminated JSP block');
}
