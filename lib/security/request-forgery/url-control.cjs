'use strict';

// Which part of a URL a request value controls, for SSRF and open redirect. Wraps taint.urlControl and adds the
// cases it reads as 'whole': a value after a clean runtime base (`${this.baseUrl}/users/${id}`), a path resolved
// against a base (`new URL(`/items/${id}`, base)`), and a const alias of either.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { strip, constantDeclaration } = require('./shared.cjs');

// A scheme and a complete host followed by a path, query or fragment: the rest cannot change the host.
const fixedOrigin = /^[a-z][a-z\d+.-]*:\/\/[^/?#]+[/?#]/i;
// A scheme, possibly with a partial host: the rest still chooses the host.
const openHost = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*$/i;
// URL fields that never carry a host.
const pathOnlyFields = new Set(['pathname', 'search', 'hash']);
// `url.toString()`, `path.replace(a, b)`: the result starts like the receiver, so it controls the same URL part.
const prefixKeepingMethods = new Set(['toString', 'replace', 'replaceAll', 'trim', 'trimEnd', 'toLowerCase']);
// Const aliases followed before giving up.
const maxAliasDepth = 4;

// `textAfterBase` is the literal text since the last clean runtime piece (env, config, `req.protocol`), or undefined.
function partAfter(prefix, textAfterBase) {
  if (openHost.test(prefix)) return 'host';
  if (textAfterBase !== undefined) return /:\/\/[^/?#]*$/.test(textAfterBase) ? 'host' : 'path';
  if (fixedOrigin.test(prefix)) return 'path';
  if (prefix.startsWith('/') && !prefix.startsWith('//')) return 'path';
  return 'whole';
}

function literalText(node, checker) {
  const value = strip(node);
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isIdentifier(value)) {
    const declaration = constantDeclaration(value, checker);
    return declaration && literalText(declaration.initializer, checker);
  }
}

// Template spans or `+` operands, left to right, as { text } or { expression }.
function urlPieces(expression, checker) {
  if (ts.isTemplateExpression(expression)) {
    const pieces = [{ text: expression.head.text }];
    for (const span of expression.templateSpans)
      pieces.push({ expression: span.expression }, { text: span.literal.text });
    return pieces;
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const operands = [];
    let left = expression;
    while (ts.isBinaryExpression(left) && left.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      operands.unshift(left.right);
      left = strip(left.left);
    }
    operands.unshift(left);
    return operands.map((operand) => {
      const text = literalText(operand, checker);
      return text === undefined ? { expression: operand } : { text };
    });
  }
}

function createUrlControl(context) {
  const { checker, taint } = context;

  function piecesControl(pieces) {
    let prefix = '';
    // Literal text after the last clean runtime piece, or undefined while every piece so far is literal.
    let textAfterBase;
    for (const piece of pieces) {
      if (piece.text !== undefined) {
        prefix += piece.text;
        if (textAfterBase !== undefined) textAfterBase += piece.text;
        continue;
      }
      const traced = taint.trace(piece.expression, 'url');
      if (!traced) {
        textAfterBase = '';
        continue;
      }
      // A traced first piece can itself be a whole URL.
      if (!prefix && textAfterBase === undefined) return control(piece.expression, 0);
      return { part: partAfter(prefix, textAfterBase), trace: traced };
    }
  }

  function control(node, depth) {
    const expression = strip(node);
    if (!expression || depth > maxAliasDepth) return;
    if (ts.isIdentifier(expression)) {
      // A guard on the alias (`if (!ALLOWED.includes(next)) return`) cleans it even though its initializer is not.
      if (!taint.trace(expression, 'url')) return;
      const declaration = constantDeclaration(expression, checker);
      if (declaration) return control(declaration.initializer, depth + 1);
    }
    // `new URL(request.url).pathname` is a path on the URL's own host.
    if (ts.isPropertyAccessExpression(expression) && pathOnlyFields.has(expression.name.text)) {
      const trace = taint.trace(expression, 'url');
      return trace && { part: 'path', trace };
    }
    // `url.href`
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'href')
      return control(expression.expression, depth + 1) ?? taint.urlControl(expression);
    if (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      prefixKeepingMethods.has(expression.expression.name.text)
    )
      return control(expression.expression.expression, depth + 1) ?? taint.urlControl(expression);
    if (
      ts.isNewExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'URL'
    )
      return newUrlControl(expression, depth);
    const pieces = urlPieces(expression, checker);
    if (pieces) return piecesControl(pieces);
    return taint.urlControl(expression);
  }

  // `new URL(input, base)`: an absolute input replaces the base, so input decides the host unless it starts as a path.
  function newUrlControl(expression, depth) {
    const [input, base] = expression.arguments ?? [];
    if (!input) return;
    const fromInput = control(input, depth + 1);
    if (fromInput) return fromInput;
    return base ? control(base, depth + 1) : undefined;
  }

  return (expression) => control(expression, 0);
}

module.exports = { createUrlControl };
