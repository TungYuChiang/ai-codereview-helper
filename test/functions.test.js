import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { getFunctionRanges } from '../functions.js';

describe('getFunctionRanges — unknown extensions', () => {
  test('returns [] for .css files', () => {
    const result = getFunctionRanges('style.css', 'body { color: red; }');
    assert.deepEqual(result, []);
  });

  test('returns [] for files with no extension', () => {
    const result = getFunctionRanges('Makefile', 'all:\n\techo hi\n');
    assert.deepEqual(result, []);
  });
});

describe('getFunctionRanges — named forms', () => {
  test('function declaration', () => {
    const content = `function foo() {\n  return 1;\n}\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [{ name: 'foo', startLine: 1, endLine: 3 }]);
  });

  test('async function declaration', () => {
    const content = `async function foo() {\n  return 1;\n}\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [{ name: 'foo', startLine: 1, endLine: 3 }]);
  });

  test('generator function declaration', () => {
    const content = `function* foo() {\n  yield 1;\n}\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [{ name: 'foo', startLine: 1, endLine: 3 }]);
  });

  test('const/let/var assigned to function expression', () => {
    const content =
      `const foo = function () {\n  return 1;\n};\n` +
      `let bar = function () {\n  return 2;\n};\n` +
      `var baz = function () {\n  return 3;\n};\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [
      { name: 'foo', startLine: 1, endLine: 3 },
      { name: 'bar', startLine: 4, endLine: 6 },
      { name: 'baz', startLine: 7, endLine: 9 },
    ]);
  });

  test('const assigned to arrow function', () => {
    const content = `const foo = () => {\n  return 1;\n};\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [{ name: 'foo', startLine: 1, endLine: 3 }]);
  });

  test('X.prototype.y = function () {}', () => {
    const content = `function X() {}\nX.prototype.y = function () {\n  return 1;\n};\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [
      { name: 'X', startLine: 1, endLine: 1 },
      { name: 'X.prototype.y', startLine: 2, endLine: 4 },
    ]);
  });

  test('X.y = function () {}', () => {
    const content = `var X = {};\nX.y = function () {\n  return 1;\n};\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [{ name: 'X.y', startLine: 2, endLine: 4 }]);
  });

  test('class methods, including getter/setter/static/private', () => {
    const content =
      `class Foo {\n` +
      `  bar() {\n    return 1;\n  }\n\n` +
      `  get baz() {\n    return 2;\n  }\n\n` +
      `  set baz(v) {\n    this._v = v;\n  }\n\n` +
      `  static qux() {\n    return 3;\n  }\n\n` +
      `  #secret() {\n    return 4;\n  }\n` +
      `}\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [
      { name: 'Foo.bar', startLine: 2, endLine: 4 },
      { name: 'Foo.baz', startLine: 6, endLine: 8 },
      { name: 'Foo.baz', startLine: 10, endLine: 12 },
      { name: 'Foo.qux', startLine: 14, endLine: 16 },
      { name: 'Foo.#secret', startLine: 18, endLine: 20 },
    ]);
  });

  test('top-level object literal methods', () => {
    const content = `var API = {\n  foo: function () {\n    return 1;\n  },\n};\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [{ name: 'API.foo', startLine: 2, endLine: 4 }]);
  });
});

describe('getFunctionRanges — export wrappers are treated as top-level scope', () => {
  test('export function declaration is still found', () => {
    const content = `export function foo() {\n  return 1;\n}\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [{ name: 'foo', startLine: 1, endLine: 3 }]);
  });

  test('export default named function declaration is still found', () => {
    const content = `export default function foo() {\n  return 1;\n}\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [{ name: 'foo', startLine: 1, endLine: 3 }]);
  });

  test('export const arrow function is still found', () => {
    const content = `export const foo = () => {\n  return 1;\n};\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [{ name: 'foo', startLine: 1, endLine: 3 }]);
  });

  test('anonymous default export produces no entry (no name to infer)', () => {
    const content = `export default () => {\n  return 1;\n};\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, []);
  });
});

describe('getFunctionRanges — nested closures are not leaked', () => {
  test('a callback passed to a top-level function does not produce its own entry', () => {
    const content =
      `function outer() {\n` +
      `  arr.map(function inner() {\n` +
      `    return 1;\n` +
      `  });\n` +
      `}\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [{ name: 'outer', startLine: 1, endLine: 5 }]);
  });

  test('anonymous function passed directly as an argument produces no entry', () => {
    const content = `setTimeout(function () {\n  doThing();\n}, 100);\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, []);
  });
});

describe('getFunctionRanges — top-level IIFE is treated as top-level scope', () => {
  test('function expression IIFE: (function(){})()', () => {
    const content =
      `(function () {\n` +
      `  function realThing() {\n    return 1;\n  }\n\n` +
      `  var API = {\n    doStuff: function () {\n      return 2;\n    },\n  };\n` +
      `})();\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [
      { name: 'realThing', startLine: 2, endLine: 4 },
      { name: 'API.doStuff', startLine: 7, endLine: 9 },
    ]);
  });

  test('function expression IIFE with call inside parens: (function(){}())', () => {
    const content = `(function () {\n  function realThing() {\n    return 1;\n  }\n}());\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [{ name: 'realThing', startLine: 2, endLine: 4 }]);
  });

  test('arrow function IIFE: (() => {})()', () => {
    const content = `(() => {\n  function realThing() {\n    return 1;\n  }\n})();\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [{ name: 'realThing', startLine: 2, endLine: 4 }]);
  });

  test('prefixed IIFE forms: !, +, void', () => {
    const bang = `!function () {\n  function a() {\n    return 1;\n  }\n}();\n`;
    const plus = `+function () {\n  function b() {\n    return 1;\n  }\n}();\n`;
    const voided = `void function () {\n  function c() {\n    return 1;\n  }\n}();\n`;

    assert.deepEqual(getFunctionRanges('foo.js', bang), [
      { name: 'a', startLine: 2, endLine: 4 },
    ]);
    assert.deepEqual(getFunctionRanges('foo.js', plus), [
      { name: 'b', startLine: 2, endLine: 4 },
    ]);
    assert.deepEqual(getFunctionRanges('foo.js', voided), [
      { name: 'c', startLine: 2, endLine: 4 },
    ]);
  });

  test('nested multi-level IIFEs are pierced all the way through', () => {
    const content =
      `(function () {\n` +
      `  (function () {\n` +
      `    function deep() {\n      return 1;\n    }\n` +
      `  })();\n` +
      `})();\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [{ name: 'deep', startLine: 3, endLine: 5 }]);
  });
});

describe('getFunctionRanges — revealing-module IIFE (var X = (function(){})()) is pierced', () => {
  test('basic revealing module: var API = (function(){...})()', () => {
    const content =
      `var API = (function () {\n` +
      `  function realThing() {\n    return 1;\n  }\n\n` +
      `  return { realThing: realThing };\n` +
      `})();\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [{ name: 'realThing', startLine: 2, endLine: 4 }]);
  });

  test('neither the IIFE nor the assigned variable itself produces an entry', () => {
    const content =
      `var API = (function () {\n` +
      `  function realThing() {\n    return 1;\n  }\n` +
      `  return { realThing: realThing };\n` +
      `})();\n`;
    const result = getFunctionRanges('foo.js', content);
    const names = result.map((r) => r.name);
    assert.ok(!names.includes('API'));
    assert.deepEqual(result, [{ name: 'realThing', startLine: 2, endLine: 4 }]);
  });

  test('call-inside-parens variant: var API = (function(){}())', () => {
    const content =
      `var API = (function () {\n` +
      `  function realThing() {\n    return 1;\n  }\n` +
      `}());\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [{ name: 'realThing', startLine: 2, endLine: 4 }]);
  });

  test('arrow function form: var API = (() => {})()', () => {
    const content =
      `var API = (() => {\n` +
      `  function realThing() {\n    return 1;\n  }\n` +
      `  return { realThing: realThing };\n` +
      `})();\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [{ name: 'realThing', startLine: 2, endLine: 4 }]);
  });

  test('prefixed forms as variable initializer: !, +, void', () => {
    const bang = `var a1 = !function () {\n  function a() {\n    return 1;\n  }\n}();\n`;
    const plus = `var a2 = +function () {\n  function b() {\n    return 1;\n  }\n}();\n`;
    const voided = `var a3 = void function () {\n  function c() {\n    return 1;\n  }\n}();\n`;

    assert.deepEqual(getFunctionRanges('foo.js', bang), [
      { name: 'a', startLine: 2, endLine: 4 },
    ]);
    assert.deepEqual(getFunctionRanges('foo.js', plus), [
      { name: 'b', startLine: 2, endLine: 4 },
    ]);
    assert.deepEqual(getFunctionRanges('foo.js', voided), [
      { name: 'c', startLine: 2, endLine: 4 },
    ]);
  });

  test('let/const assigned to a revealing-module IIFE are pierced the same way', () => {
    const letContent =
      `let API = (function () {\n  function realThing() {\n    return 1;\n  }\n})();\n`;
    const constContent =
      `const API = (function () {\n  function realThing() {\n    return 1;\n  }\n})();\n`;

    assert.deepEqual(getFunctionRanges('foo.js', letContent), [
      { name: 'realThing', startLine: 2, endLine: 4 },
    ]);
    assert.deepEqual(getFunctionRanges('foo.js', constContent), [
      { name: 'realThing', startLine: 2, endLine: 4 },
    ]);
  });

  test('nested revealing-module IIFEs are pierced all the way through', () => {
    const content =
      `var Outer = (function () {\n` +
      `  var Inner = (function () {\n` +
      `    function deep() {\n      return 1;\n    }\n` +
      `    return { deep: deep };\n` +
      `  })();\n` +
      `  return Inner;\n` +
      `})();\n`;
    const result = getFunctionRanges('foo.js', content);
    const names = result.map((r) => r.name);
    assert.ok(!names.includes('Outer'));
    assert.ok(!names.includes('Inner'));
    assert.deepEqual(result, [{ name: 'deep', startLine: 3, endLine: 5 }]);
  });

  test('nested: revealing-module IIFE containing a bare-statement IIFE', () => {
    const content =
      `var Outer = (function () {\n` +
      `  (function () {\n` +
      `    function deep() {\n      return 1;\n    }\n` +
      `  })();\n` +
      `})();\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(result, [{ name: 'deep', startLine: 3, endLine: 5 }]);
  });
});

describe('getFunctionRanges — recognized extensions', () => {
  for (const ext of ['.js', '.mjs', '.cjs', '.jsx']) {
    test(`recognizes ${ext} files`, () => {
      const content = `function foo() {\n  return 1;\n}\n`;
      const result = getFunctionRanges(`foo${ext}`, content);
      assert.deepEqual(result, [{ name: 'foo', startLine: 1, endLine: 3 }]);
    });
  }

  test('returns [] for .java files', () => {
    const result = getFunctionRanges('Foo.java', 'class Foo { void bar() {} }');
    assert.deepEqual(result, []);
  });

  test('returns [] for .jsp files', () => {
    const result = getFunctionRanges('page.jsp', '<%@ page language="java" %>');
    assert.deepEqual(result, []);
  });
});

describe('getFunctionRanges — parse error tolerance', () => {
  test('returns [] instead of throwing for syntactically invalid JS', () => {
    const content = `function foo( {\n  this is not valid js at all ][\n`;
    assert.doesNotThrow(() => getFunctionRanges('foo.js', content));
    assert.deepEqual(getFunctionRanges('foo.js', content), []);
  });
});

describe('getFunctionRanges — sorting', () => {
  test('results are sorted by startLine ascending regardless of declaration order', () => {
    const content =
      `var API = {\n  late: function () {\n    return 1;\n  },\n};\n\n` +
      `function early() {\n  return 2;\n}\n`;
    const result = getFunctionRanges('foo.js', content);
    assert.deepEqual(
      result.map((r) => r.name),
      ['API.late', 'early'],
    );
    assert.ok(result[0].startLine < result[1].startLine);
  });
});
