import { createHash } from 'node:crypto';
import * as acorn from 'acorn';
import MagicString from 'magic-string';

// window.location はブラウザ側で再定義できないため、JS ソース中の location 参照を
// ラッパー関数経由に書き換える (関数本体は public/client.js で定義)。
//   location            -> __pxL(location)            読み取り: 偽の Location を返す
//   x.location          -> __pxL(x.location)
//   location = v        -> location = __pxA(location, v)   代入: URL をプロキシ形式に
//   x.location = v      -> __pxSet(x, v)
// ラッパーは引数が本物の Location の時だけ作用するので、location という名前の
// ローカル変数やプロパティがあっても安全 (そのまま値を返す)。

// Worker など client.js が読み込まれない環境向けのフォールバック定義
export const JS_PROLOGUE =
  'globalThis.__pxL||(globalThis.__pxL=function(x){return x},' +
  'globalThis.__pxA=function(c,v){return v},' +
  'globalThis.__pxSet=function(o,v){return o.location=v});';

const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range', 'raw', 'regex', 'bigint']);

function isLocationProp(node) {
  if (node.type !== 'MemberExpression') return false;
  const p = node.property;
  if (!node.computed) return p.type === 'Identifier' && p.name === 'location';
  return p.type === 'Literal' && p.value === 'location';
}

// visit(node, parent, key, grand) が false を返すと子は辿らない。
// ChainExpression (a?.b) の内側は意味が変わりやすいので丸ごと書き換え対象外にする。
function walk(root, visit) {
  const rec = (node, parent, key, grand) => {
    if (node.type === 'ChainExpression') return;
    if (visit(node, parent, key, grand, rec) === false) return;
    for (const k of Object.keys(node)) {
      if (SKIP_KEYS.has(k)) continue;
      const child = node[k];
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c.type === 'string') rec(c, node, k, parent);
      } else if (child && typeof child.type === 'string') {
        rec(child, node, k, parent);
      }
    }
  };
  rec(root, null, null, null);
}

// Identifier が「値として読まれる位置」にあるか (宣言・プロパティ名・ラベル等は除外)
function isReadReference(parent, key, grand) {
  switch (parent.type) {
    case 'MemberExpression':
      return key === 'object' || parent.computed;
    case 'Property':
      if (key === 'key') return parent.computed;
      return grand?.type !== 'ObjectPattern' && !parent.shorthand;
    case 'PropertyDefinition':
    case 'MethodDefinition':
      return key === 'key' ? parent.computed : true;
    case 'VariableDeclarator':
      return key !== 'id';
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return key === 'body';
    case 'ClassDeclaration':
    case 'ClassExpression':
      return key !== 'id';
    case 'CatchClause':
      return key !== 'param';
    case 'ArrayPattern':
    case 'ObjectPattern':
    case 'RestElement':
      return false;
    case 'AssignmentPattern':
      return key === 'right';
    case 'AssignmentExpression':
      return key === 'right';
    case 'UpdateExpression':
      return false;
    case 'UnaryExpression':
      return parent.operator !== 'delete';
    case 'ForInStatement':
    case 'ForOfStatement':
      return key !== 'left';
    case 'CallExpression':
    case 'NewExpression':
      return key !== 'callee';
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
    case 'MetaProperty':
      return false;
    default:
      return true;
  }
}

function parse(src, { module, handler }) {
  const opts = {
    ecmaVersion: 'latest',
    preserveParens: true,
    allowHashBang: true,
    allowReturnOutsideFunction: !!handler,
    allowAwaitOutsideFunction: !module,
  };
  if (module === true) return acorn.parse(src, { ...opts, sourceType: 'module' });
  if (module === false) return acorn.parse(src, { ...opts, sourceType: 'script' });
  try {
    return acorn.parse(src, { ...opts, sourceType: 'script' });
  } catch {
    return acorn.parse(src, { ...opts, sourceType: 'module', allowAwaitOutsideFunction: false });
  }
}

function transform(src, { module, handler, prologue }) {
  const ast = parse(src, { module, handler });
  const ms = new MagicString(src);
  const open = (pos, text) => ms.appendLeft(pos, text);
  const close = (pos) => ms.prependLeft(pos, ')');
  let changed = false;

  walk(ast, (node, parent, key, grand, rec) => {
    if (node.type === 'AssignmentExpression' && node.operator === '=') {
      const left = node.left;
      if (left.type === 'Identifier' && left.name === 'location') {
        open(node.right.start, '__pxA(location,');
        close(node.right.end);
        changed = true;
        rec(node.right, node, 'right', parent);
        return false;
      }
      if (isLocationProp(left)) {
        open(left.start, '__pxSet(');
        ms.overwrite(left.object.end, node.right.start, ',');
        close(node.right.end);
        changed = true;
        // left.property は再訪しないよう、object と right だけ辿る
        rec(left.object, left, 'object', node);
        rec(node.right, node, 'right', parent);
        return false;
      }
      return;
    }

    if (node.type === 'Identifier' && node.name === 'location' && parent) {
      if (parent.type === 'Property' && parent.shorthand && key === 'value' && grand?.type === 'ObjectExpression') {
        ms.appendLeft(parent.key.end, ':__pxL(location)');
        changed = true;
        return;
      }
      if (isReadReference(parent, key, grand)) {
        open(node.start, '__pxL(');
        close(node.end);
        changed = true;
      }
      return;
    }

    if (isLocationProp(node) && parent) {
      const isTarget =
        (parent.type === 'AssignmentExpression' && key === 'left') ||
        parent.type === 'UpdateExpression' ||
        (parent.type === 'UnaryExpression' && parent.operator === 'delete') ||
        ((parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') && key === 'left') ||
        (parent.type === 'CallExpression' && key === 'callee') ||
        parent.type === 'ArrayPattern' ||
        parent.type === 'AssignmentPattern' ||
        parent.type === 'RestElement' ||
        (parent.type === 'Property' && key === 'value' && grand?.type === 'ObjectPattern');
      if (!isTarget) {
        open(node.start, '__pxL(');
        close(node.end);
        changed = true;
      }
    }
  });

  if (prologue) {
    // "use strict" などのディレクティブより後ろに入れる (前に入れると strict モードが外れる)
    let pos = 0;
    for (const stmt of ast.body) {
      if (stmt.type === 'ExpressionStatement' && typeof stmt.directive === 'string') pos = stmt.end;
      else break;
    }
    if (pos === 0 && src.startsWith('#!')) pos = src.indexOf('\n') + 1 || src.length;
    ms.appendLeft(pos, pos === 0 ? JS_PROLOGUE : ';' + JS_PROLOGUE);
    changed = true;
  }
  return changed ? ms.toString() : src;
}

const cache = new Map();
const CACHE_MAX = 300;

/**
 * JS を書き換える。構文解析に失敗した場合は元のソースをそのまま返す (壊すよりマシ)。
 * @param {string} src
 * @param {{module?: boolean, handler?: boolean, prologue?: boolean}} [opts]
 */
export function rewriteJs(src, opts = {}) {
  if (!src.includes('location') && !opts.prologue) return src;
  const key = createHash('sha1').update(JSON.stringify(opts)).update(src).digest('base64');
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let out;
  try {
    out = transform(src, opts);
  } catch {
    out = opts.prologue ? JS_PROLOGUE + '\n' + src : src;
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, out);
  return out;
}
