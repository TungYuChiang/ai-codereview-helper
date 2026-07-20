// functions.js — 用 acorn 找出檔案裡每個「最外層具名單位」的起訖行。
//
// 純函式：吃字串吐結構，不碰檔案系統、不執行子行程。

import { parse } from 'acorn';

const RECOGNIZED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx']);

/**
 * @param {string} filePath 用來判斷副檔名
 * @param {string} content 該檔案的完整內容（新版）
 * @returns {{ name: string, startLine: number, endLine: number }[]}
 */
export function getFunctionRanges(filePath, content) {
  if (!hasRecognizedExtension(filePath)) {
    return [];
  }

  const ast = parseSource(content);
  if (ast === null) {
    return [];
  }

  const ranges = [];
  collectFromBody(ast.body, ranges);
  ranges.sort((a, b) => a.startLine - b.startLine);
  return ranges;
}

function hasRecognizedExtension(filePath) {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) {
    return false;
  }
  const ext = filePath.slice(dot).toLowerCase();
  return RECOGNIZED_EXTENSIONS.has(ext);
}

function parseSource(content) {
  const options = { ecmaVersion: 'latest', locations: true };
  try {
    return parse(content, { ...options, sourceType: 'module' });
  } catch {
    // fall through
  }
  try {
    return parse(content, { ...options, sourceType: 'script' });
  } catch {
    return null;
  }
}

/**
 * 走訪一段「頂層作用域」的 statement 陣列，把找到的具名 function 範圍推進 ranges。
 * 遇到 IIFE 時，把它的 body 也當成頂層作用域繼續往下找（不產生自己的一筆）。
 */
function collectFromBody(body, ranges) {
  for (const statement of body) {
    collectFromStatement(statement, ranges);
  }
}

function collectFromStatement(node, ranges) {
  if (!node) return;

  switch (node.type) {
    case 'FunctionDeclaration': {
      if (node.id && node.id.name) {
        pushRange(ranges, node.id.name, node);
      }
      break;
    }

    case 'VariableDeclaration': {
      for (const decl of node.declarations) {
        if (!decl.id || decl.id.type !== 'Identifier' || !decl.init) continue;

        if (isFunctionExpressionLike(decl.init)) {
          pushRange(ranges, decl.id.name, decl.init);
        } else if (decl.init.type === 'ObjectExpression') {
          collectFromObjectLiteral(decl.id.name, decl.init, ranges);
        } else {
          // Revealing-module pattern: var API = (function () { ... })();
          // Pierce into the IIFE body like the bare-statement IIFE path does;
          // neither the IIFE nor the variable itself produces an entry.
          const iifeCallee = getIifeCallee(decl.init);
          if (iifeCallee) {
            collectFromFunctionBody(iifeCallee, ranges);
          }
        }
      }
      break;
    }

    case 'ExpressionStatement': {
      collectFromExpressionStatement(node.expression, ranges);
      break;
    }

    case 'ClassDeclaration': {
      collectFromClass(node, ranges);
      break;
    }

    // `export function foo() {}` / `export default class {}` 等 —
    // export 只是包一層，底下仍是頂層作用域的宣告，繼續往下找。
    case 'ExportNamedDeclaration':
    case 'ExportDefaultDeclaration': {
      if (node.declaration) {
        collectFromStatement(node.declaration, ranges);
      }
      break;
    }

    default:
      break;
  }
}

function collectFromExpressionStatement(expr, ranges) {
  if (!expr) return;

  // IIFE：把 call 展開一層前綴一元運算子 (!, +, void ...)
  const iifeCallee = getIifeCallee(expr);
  if (iifeCallee) {
    collectFromFunctionBody(iifeCallee, ranges);
    return;
  }

  if (
    expr.type === 'AssignmentExpression' &&
    expr.operator === '=' &&
    isFunctionExpressionLike(expr.right)
  ) {
    const name = memberExpressionName(expr.left);
    if (name) {
      pushRange(ranges, name, expr.right);
    }
  }
}

/**
 * 若 expr 是一次立即呼叫 (IIFE)，回傳被呼叫的 function expression 節點；否則回傳 null。
 * 支援 (function(){})()、(function(){}())、(()=>{})()，
 * 以及前綴 !、+、void 的形式。
 */
function getIifeCallee(expr) {
  let node = expr;

  // 前綴一元運算子：!fn(), +fn(), void fn()
  while (node && node.type === 'UnaryExpression') {
    node = node.argument;
  }

  if (!node || node.type !== 'CallExpression') {
    return null;
  }

  const callee = node.callee;
  if (
    callee &&
    (callee.type === 'FunctionExpression' || callee.type === 'ArrowFunctionExpression')
  ) {
    return callee;
  }

  return null;
}

function collectFromFunctionBody(fnNode, ranges) {
  const body = fnNode.body;
  if (body && body.type === 'BlockStatement') {
    collectFromBody(body.body, ranges);
  }
  // ArrowFunctionExpression 的 body 也可能是單一 expression（無 block），
  // 這種情況下裡面不可能有 statement，忽略即可。
}

/**
 * 頂層物件字面值：var API = { foo: function () {} }
 * 只掃一層 property；property 的 value 不是 function 就略過（不遞迴進非 function 的值）。
 */
function collectFromObjectLiteral(objectName, objectExpr, ranges) {
  for (const prop of objectExpr.properties) {
    if (prop.type !== 'Property' || !isFunctionExpressionLike(prop.value)) continue;
    const propName = propertyKeyName(prop.key, prop.computed);
    if (!propName) continue;
    pushRange(ranges, `${objectName}.${propName}`, prop.value);
  }
}

function collectFromClass(classNode, ranges) {
  const className = classNode.id && classNode.id.name;
  if (!className) return;

  for (const member of classNode.body.body) {
    if (member.type !== 'MethodDefinition') continue;
    if (!isFunctionExpressionLike(member.value)) continue;

    const methodName = propertyKeyName(member.key, member.computed);
    if (!methodName) continue;

    pushRange(ranges, `${className}.${methodName}`, member.value);
  }
}

function isFunctionExpressionLike(node) {
  return node && (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression');
}

/**
 * 取得 X.prototype.y / X.y 形式的完整成員名稱；不支援的形態回傳 null。
 */
function memberExpressionName(node) {
  if (!node || node.type !== 'MemberExpression') return null;
  return expressionToDottedName(node);
}

function expressionToDottedName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed) {
    const objectName = expressionToDottedName(node.object);
    const propName = node.property.type === 'Identifier' ? node.property.name : null;
    if (!objectName || !propName) return null;
    return `${objectName}.${propName}`;
  }
  return null;
}

function propertyKeyName(key, computed) {
  if (computed) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'PrivateIdentifier') return `#${key.name}`;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

function pushRange(ranges, name, node) {
  ranges.push({
    name,
    startLine: node.loc.start.line,
    endLine: node.loc.end.line,
  });
}
