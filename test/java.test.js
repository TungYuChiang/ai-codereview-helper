import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { getFunctionRanges } from '../functions.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

/** 只比對名字，行號另外斷言，讓失敗訊息好讀。 */
const names = (ranges) => ranges.map((r) => r.name);

// ---------------------------------------------------------------------------
// .java — 基本單位：method 與 constructor
// ---------------------------------------------------------------------------

describe('getFunctionRanges — java basics', () => {
  test('a method of a top-level class is its own unit, named Class.method', () => {
    const content = ['public class Foo {', '  void bar() {', '    x();', '  }', '}', ''].join('\n');
    assert.deepEqual(getFunctionRanges('Foo.java', content), [
      { name: 'Foo.bar', startLine: 2, endLine: 4 },
    ]);
  });

  test('several methods each get their own range', () => {
    const content = [
      'class Foo {',
      '  void a() {',
      '  }',
      '',
      '  int b() {',
      '    return 1;',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('Foo.java', content), [
      { name: 'Foo.a', startLine: 2, endLine: 3 },
      { name: 'Foo.b', startLine: 5, endLine: 7 },
    ]);
  });

  test('the class itself is not a unit (otherwise the range is the whole file)', () => {
    const content = ['class Foo {', '  void bar() {', '  }', '}'].join('\n');
    const result = getFunctionRanges('Foo.java', content);
    assert.deepEqual(names(result), ['Foo.bar']);
  });

  test('constructor is a unit, named Class.Class', () => {
    const content = ['class Foo {', '  Foo(int x) {', '    this.x = x;', '  }', '}'].join('\n');
    assert.deepEqual(getFunctionRanges('Foo.java', content), [
      { name: 'Foo.Foo', startLine: 2, endLine: 4 },
    ]);
  });

  test('range starts at the modifiers, not at the annotation or javadoc above it', () => {
    const content = [
      'class Foo {',
      '  /** doc */',
      '  @Override',
      '  public String toString() {',
      '    return "x";',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('Foo.java', content), [
      { name: 'Foo.toString', startLine: 4, endLine: 6 },
    ]);
  });

  test('methods of nested and inner classes are qualified by the whole class chain', () => {
    const content = [
      'class Outer {',
      '  void outerMethod() {',
      '  }',
      '  static class Inner {',
      '    void doThing() {',
      '    }',
      '    class Deep {',
      '      void deepest() {',
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(names(getFunctionRanges('Outer.java', content)), [
      'Outer.outerMethod',
      'Outer.Inner.doThing',
      'Outer.Inner.Deep.deepest',
    ]);
  });

  test('two top-level types in one file are both walked', () => {
    const content = ['class A {', '  void a() {}', '}', 'class B {', '  void b() {}', '}'].join(
      '\n',
    );
    assert.deepEqual(names(getFunctionRanges('A.java', content)), ['A.a', 'B.b']);
  });
});

// ---------------------------------------------------------------------------
// .java — 什麼不是 unit
// ---------------------------------------------------------------------------

describe('getFunctionRanges — java non-units fall through to the file bucket', () => {
  test('fields, imports and package produce no ranges', () => {
    const content = [
      'package com.example;',
      '',
      'import java.util.List;',
      '',
      'class Foo {',
      '  private int count = 0;',
      '  private static final String NAME = "foo";',
      '}',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('Foo.java', content), []);
  });

  test('abstract / interface method declarations without a body are not ranges', () => {
    const content = [
      'interface Foo {',
      '  void noBody();',
      '  default int withBody() {',
      '    return 1;',
      '  }',
      '  static int alsoBody() {',
      '    return 2;',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('Foo.java', content), [
      { name: 'Foo.withBody', startLine: 3, endLine: 5 },
      { name: 'Foo.alsoBody', startLine: 6, endLine: 8 },
    ]);
  });

  test('static and instance initializer blocks are not their own units', () => {
    const content = [
      'class Foo {',
      '  static {',
      '    init();',
      '  }',
      '  {',
      '    also();',
      '  }',
      '  void real() {',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('Foo.java', content), [
      { name: 'Foo.real', startLine: 8, endLine: 9 },
    ]);
  });

  test('lambdas and anonymous classes belong to the enclosing method, not to themselves', () => {
    const content = [
      'class Foo {',
      '  void run() {',
      '    list.forEach(item -> {',
      '      use(item);',
      '    });',
      '    new Runnable() {',
      '      public void run() {',
      '        inner();',
      '      }',
      '    }.run();',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('Foo.java', content), [
      { name: 'Foo.run', startLine: 2, endLine: 11 },
    ]);
  });

  test('an anonymous class assigned to a field is not split out', () => {
    const content = [
      'class Foo {',
      '  private Runnable r = new Runnable() {',
      '    public void run() {',
      '      go();',
      '    }',
      '  };',
      '  void after() {',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('Foo.java', content), [
      { name: 'Foo.after', startLine: 7, endLine: 8 },
    ]);
  });

  test('array initializer at class-body level is not mistaken for a method body', () => {
    const content = [
      'class Foo {',
      '  private int[] x = {1, 2, 3};',
      '  private static final String[][] Y = {',
      '    {"a", "b"},',
      '    {"c"},',
      '  };',
      '  void after() {',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('Foo.java', content), [
      { name: 'Foo.after', startLine: 7, endLine: 8 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// .java — lexer 的重點：註解、字串、字元、text block
// ---------------------------------------------------------------------------

describe('getFunctionRanges — java lexing hazards', () => {
  test('braces and apostrophes inside a line comment do not affect depth', () => {
    const content = [
      'class Foo {',
      '  void a() {',
      "    // don't do this {",
      '  }',
      '  void b() {',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('Foo.java', content), [
      { name: 'Foo.a', startLine: 2, endLine: 4 },
      { name: 'Foo.b', startLine: 5, endLine: 6 },
    ]);
  });

  test('quotes and braces inside a block comment do not affect depth', () => {
    const content = [
      'class Foo {',
      '  /* he said "hi" { */',
      '  void a() {',
      '    /* } } } */',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('Foo.java', content), [
      { name: 'Foo.a', startLine: 3, endLine: 5 },
    ]);
  });

  test('// inside a string literal does not start a comment', () => {
    const content = [
      'class Foo {',
      '  void a() {',
      '    String url = "http://example.com"; ',
      '    call();',
      '  }',
      '  void b() {',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(names(getFunctionRanges('Foo.java', content)), ['Foo.a', 'Foo.b']);
  });

  test('escaped quotes and backslashes inside strings', () => {
    const content = [
      'class Foo {',
      '  void a() {',
      '    String s = "she said \\"hi\\" {";',
      '    String t = "\\\\";',
      '    String u = "}}}";',
      '  }',
      '  void b() {',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(names(getFunctionRanges('Foo.java', content)), ['Foo.a', 'Foo.b']);
  });

  test('char literals containing braces, quotes and backslashes', () => {
    const content = [
      'class Foo {',
      '  void a() {',
      "    char open = '{';",
      "    char close = '}';",
      "    char quote = '\\'';",
      "    char back = '\\\\';",
      '  }',
      '  void b() {',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(names(getFunctionRanges('Foo.java', content)), ['Foo.a', 'Foo.b']);
  });

  test('text blocks may contain quotes, braces and slashes', () => {
    const content = [
      'class Foo {',
      '  void a() {',
      '    String s = """',
      '        { "not json" // not a comment',
      '        }}}',
      '        """;',
      '  }',
      '  void b() {',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('Foo.java', content), [
      { name: 'Foo.a', startLine: 2, endLine: 7 },
      { name: 'Foo.b', startLine: 8, endLine: 9 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// .java — 宣告語法的花樣
// ---------------------------------------------------------------------------

describe('getFunctionRanges — java declaration shapes', () => {
  test('annotation arguments containing braces', () => {
    const content = [
      'class Foo {',
      '  @SuppressWarnings({"unchecked", "rawtypes"})',
      '  void a() {',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('Foo.java', content), [
      { name: 'Foo.a', startLine: 3, endLine: 4 },
    ]);
  });

  test('generic method signatures with bounded wildcards', () => {
    const content = [
      'class Foo {',
      '  public static <T extends Comparable<? super T>> void sort(List<T> l) {',
      '    l.sort(null);',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('Foo.java', content), [
      { name: 'Foo.sort', startLine: 2, endLine: 4 },
    ]);
  });

  test('throws clauses, varargs and array return types', () => {
    const content = [
      'class Foo {',
      '  public String[] pick(int... xs) throws IOException, RuntimeException {',
      '    return null;',
      '  }',
      '  int[][] grid() {',
      '    return null;',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(names(getFunctionRanges('Foo.java', content)), ['Foo.pick', 'Foo.grid']);
  });

  test('enum: methods are units, constants (with or without bodies) are not', () => {
    const content = [
      'enum E {',
      '  A {',
      '    void m() {',
      '    }',
      '  },',
      '  B;',
      '  void n() {',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('E.java', content), [
      { name: 'E.n', startLine: 7, endLine: 8 },
    ]);
  });

  test('enum with a constructor and constants carrying arguments', () => {
    const content = [
      'enum E {',
      '  A("a"), B("b");',
      '  private final String s;',
      '  E(String s) {',
      '    this.s = s;',
      '  }',
      '  String get() {',
      '    return s;',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(names(getFunctionRanges('E.java', content)), ['E.E', 'E.get']);
  });

  test('an enum with no member section (no `;`) does not derail the rest of the file', () => {
    // 常數列表如果沒被當成常數列表解析，`A { ... }` 會被當成成員宣告，
    // 撞到 enum 的右大括號後整份 fail closed —— 連後面的 class 都會消失。
    const content = [
      'enum E {',
      '  A {',
      '    void hidden() {}',
      '  }',
      '}',
      'class Other {',
      '  void real() {',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('E.java', content), [
      { name: 'Other.real', startLine: 7, endLine: 8 },
    ]);
  });

  test('annotation type elements with a default array value are not ranges', () => {
    const content = [
      'public @interface Ann {',
      '  String value() default "x";',
      '  String[] tags() default {};',
      '  Class<?>[] groups() default {Default.class};',
      '}',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('Ann.java', content), []);
  });

  test('nested enum and interface inside a class', () => {
    const content = [
      'class Outer {',
      '  enum Kind {',
      '    A;',
      '    void k() {',
      '    }',
      '  }',
      '  interface Cb {',
      '    void onDone();',
      '  }',
      '  void go() {',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(names(getFunctionRanges('Outer.java', content)), [
      'Outer.Kind.k',
      'Outer.go',
    ]);
  });

  // 註：Java 是嚴格由上而下解析的，範圍天生就依 startLine 遞增產出，
  // 所以 java.js 裡的 sortRanges() 是「保證合約」而非「修正順序」——
  // 沒有任何輸入能讓拿掉排序後這個測試變紅。這裡驗的是對外的輸出不變量。
  test('ranges come out in ascending startLine order', () => {
    const content = [
      'class Outer {',
      '  static class Inner {',
      '    void first() {',
      '    }',
      '  }',
      '  void second() {',
      '  }',
      '}',
    ].join('\n');
    const result = getFunctionRanges('Outer.java', content);
    assert.deepEqual(names(result), ['Outer.Inner.first', 'Outer.second']);
    assert.ok(result[0].startLine < result[1].startLine);
  });
});

// ---------------------------------------------------------------------------
// .java — fail closed
// ---------------------------------------------------------------------------

describe('getFunctionRanges — java fails closed', () => {
  test('empty file', () => {
    assert.deepEqual(getFunctionRanges('Foo.java', ''), []);
  });

  test('file with no methods at all', () => {
    assert.deepEqual(getFunctionRanges('Foo.java', 'package a.b;\nimport c.D;\n'), []);
  });

  test('unbalanced braces return [] instead of a wrong range, and do not throw', () => {
    const content = ['class Foo {', '  void a() {', '    if (x) {', '  }', '}'].join('\n');
    assert.doesNotThrow(() => getFunctionRanges('Foo.java', content));
    assert.deepEqual(getFunctionRanges('Foo.java', content), []);
  });

  test('a stray closing brace returns []', () => {
    const content = ['class Foo {', '  void a() {', '  }', '  }', '}', '}'].join('\n');
    assert.deepEqual(getFunctionRanges('Foo.java', content), []);
  });

  test('unterminated string returns []', () => {
    const content = ['class Foo {', '  void a() {', '    String s = "oops;', '  }', '}'].join('\n');
    assert.doesNotThrow(() => getFunctionRanges('Foo.java', content));
    assert.deepEqual(getFunctionRanges('Foo.java', content), []);
  });

  test('unterminated block comment returns []', () => {
    const content = ['class Foo {', '  /* never closed', '  void a() {', '  }', '}'].join('\n');
    assert.deepEqual(getFunctionRanges('Foo.java', content), []);
  });

  test('unterminated text block returns []', () => {
    const content = ['class Foo {', '  void a() {', '    String s = """', '    oops;'].join('\n');
    assert.deepEqual(getFunctionRanges('Foo.java', content), []);
  });

  test('a stray statement at class-body level returns [] rather than a bogus unit', () => {
    // 不是合法 Java，但半殘的檔案真的會長這樣。`if (x) { }` 的 `(` 前面是 `if`，
    // 若沒有擋下來就會生出 `Foo.if` 這種不存在的 method 範圍 —— 錯的範圍會把
    // 改動靜默掛到別的地方，比整份降級成檔案層糟糕得多。
    const content = [
      'class Foo {',
      '  if (x) {',
      '  }',
      '  void real() {',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('Foo.java', content), []);
  });

  test('a .java file whose content is not Java at all returns []', () => {
    const content = '<html><body><p>hello &amp; goodbye</p></body></html>\n';
    assert.doesNotThrow(() => getFunctionRanges('Foo.java', content));
    assert.deepEqual(getFunctionRanges('Foo.java', content), []);
  });

  test('a .java file containing JS returns [] rather than JS ranges', () => {
    const content = 'function foo() {\n  return 1;\n}\n';
    assert.deepEqual(getFunctionRanges('Foo.java', content), []);
  });
});

// ---------------------------------------------------------------------------
// .java — 綜合 fixture
// ---------------------------------------------------------------------------

describe('getFunctionRanges — java fixture', () => {
  test('Sample.java yields exactly the expected units with the expected ranges', () => {
    const result = getFunctionRanges('Sample.java', fixture('Sample.java'));
    assert.deepEqual(result, [
      { name: 'Sample.Sample', startLine: 21, endLine: 23 },
      { name: 'Sample.describe', startLine: 30, endLine: 39 },
      { name: 'Sample.render', startLine: 42, endLine: 49 },
      { name: 'Sample.sort', startLine: 52, endLine: 54 },
      { name: 'Sample.Kind.label', startLine: 61, endLine: 63 },
      { name: 'Sample.Helper.help', startLine: 68, endLine: 70 },
      { name: 'Sample.Helper.Deep.deep', startLine: 73, endLine: 75 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// .jsp
// ---------------------------------------------------------------------------

describe('getFunctionRanges — jsp', () => {
  test('methods inside a <%! %> declaration block become ranges', () => {
    const content = [
      '<html>',
      '<%!',
      '  int add(int a, int b) {',
      '    return a + b;',
      '  }',
      '%>',
      '</html>',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('p.jsp', content), [
      { name: 'add', startLine: 3, endLine: 5 },
    ]);
  });

  test('line numbers are relative to the whole file, not to the block', () => {
    const content = [
      '<%@ page contentType="text/html" %>', // 1
      '<html>', // 2
      '<body>', // 3
      '<% String x = "hi"; %>', // 4
      '<div>${x}</div>', // 5
      '<%-- comment --%>', // 6
      '<table><tr><td>plain html</td></tr></table>', // 7
      '<%!', // 8
      '  private String greet(String who) {', // 9
      '    return "hi " + who;', // 10
      '  }', // 11
      '%>', // 12
      '</body>', // 13
    ].join('\n');
    assert.deepEqual(getFunctionRanges('p.jsp', content), [
      { name: 'greet', startLine: 9, endLine: 11 },
    ]);
  });

  test('scriptlets, expressions, directives, EL and taglibs produce no ranges', () => {
    const content = [
      '<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core" %>',
      '<c:forEach items="${list}" var="i">',
      '  <%= i.getName() %>',
      '  <% if (i != null) { out.print("x"); } %>',
      '</c:forEach>',
      '${empty list ? "none" : "some"}',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('p.jsp', content), []);
  });

  test('a JSP comment may contain <% and %> and unbalanced braces', () => {
    const content = [
      '<%-- <% this { is not code %> and neither is } --%>',
      '<%!',
      '  void real() {',
      '  }',
      '%>',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('p.jsp', content), [
      { name: 'real', startLine: 3, endLine: 4 },
    ]);
  });

  test("a JSP comment containing an apostrophe is skipped wholesale, not lexed as Java", () => {
    // 若 <%-- --%> 沒有先被整團剝掉，`it's` 的單引號會被當成未收尾的 char literal，
    // 整份檔案 fail closed，連下面正常的宣告區塊都會不見。
    const content = [
      '<%--',
      "  TODO: it's broken, and this quote \" is unbalanced too",
      '--%>',
      '<%!',
      '  void real() {',
      '  }',
      '%>',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('p.jsp', content), [
      { name: 'real', startLine: 5, endLine: 6 },
    ]);
  });

  test('a stray closing brace in a declaration block returns []', () => {
    const content = ['<%!', '  void ok() {', '  }', '  }', '%>'].join('\n');
    assert.deepEqual(getFunctionRanges('p.jsp', content), []);
  });

  test('fields in a declaration block fall through; only methods are ranges', () => {
    const content = [
      '<%!',
      '  private static final int MAX = 10;',
      '  private String name = "x";',
      '  int get() {',
      '    return MAX;',
      '  }',
      '%>',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('p.jsp', content), [
      { name: 'get', startLine: 4, endLine: 6 },
    ]);
  });

  test('multiple declaration blocks in one file', () => {
    const content = [
      '<%!',
      '  void first() {',
      '  }',
      '%>',
      '<p>html between</p>',
      '<% out.print("scriptlet"); %>',
      '<%!',
      '  void second() {',
      '  }',
      '%>',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('p.jsp', content), [
      { name: 'first', startLine: 2, endLine: 3 },
      { name: 'second', startLine: 8, endLine: 9 },
    ]);
  });

  test('a nested class inside a declaration block qualifies its methods', () => {
    const content = [
      '<%!',
      '  static class Helper {',
      '    void help() {',
      '    }',
      '  }',
      '%>',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('p.jsp', content), [
      { name: 'Helper.help', startLine: 3, endLine: 4 },
    ]);
  });

  test('an unescaped %> inside a Java string does not close the block early', () => {
    const content = [
      '<%!',
      '  String tag() {',
      '    return "<div%>";',
      '  }',
      '%>',
      '<p>after</p>',
    ].join('\n');
    assert.deepEqual(getFunctionRanges('p.jsp', content), [
      { name: 'tag', startLine: 2, endLine: 4 },
    ]);
  });

  test('the JSP-spec escape %\\> inside a string is also tolerated', () => {
    const content = ['<%!', '  String tag() {', '    return "<div%\\>";', '  }', '%>'].join('\n');
    assert.deepEqual(getFunctionRanges('p.jsp', content), [
      { name: 'tag', startLine: 2, endLine: 4 },
    ]);
  });

  test('empty jsp file', () => {
    assert.deepEqual(getFunctionRanges('p.jsp', ''), []);
  });

  test('jsp with no declaration block at all', () => {
    assert.deepEqual(getFunctionRanges('p.jsp', '<html><body>hi</body></html>\n'), []);
  });

  test('unbalanced braces inside a declaration block return [] for the whole file', () => {
    const content = [
      '<%!',
      '  void ok() {',
      '  }',
      '%>',
      '<%!',
      '  void broken() {',
      '    if (x) {',
      '  }',
      '%>',
    ].join('\n');
    assert.doesNotThrow(() => getFunctionRanges('p.jsp', content));
    assert.deepEqual(getFunctionRanges('p.jsp', content), []);
  });

  test('an unterminated declaration block returns []', () => {
    const content = ['<html>', '<%!', '  void ok() {', '  }'].join('\n');
    assert.deepEqual(getFunctionRanges('p.jsp', content), []);
  });

  test('an unterminated string inside a scriptlet returns []', () => {
    const content = ['<% String s = "oops; %>', '<%!', '  void ok() {', '  }', '%>'].join('\n');
    assert.deepEqual(getFunctionRanges('p.jsp', content), []);
  });

  test('sample.jsp fixture yields exactly the expected units with the expected ranges', () => {
    const result = getFunctionRanges('sample.jsp', fixture('sample.jsp'));
    assert.deepEqual(result, [
      { name: 'formatName', startLine: 22, endLine: 27 },
      { name: 'Row.render', startLine: 30, endLine: 32 },
      { name: 'total', startLine: 40, endLine: 46 },
    ]);
  });
});
