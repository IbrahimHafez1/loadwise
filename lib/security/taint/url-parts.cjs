'use strict';

const { syntax: ts } = require('../../performance/compiler.cjs');
const { importedFrom } = require('../bindings.cjs');

// A scheme and a complete host followed by a path, query or fragment: the rest cannot change the host.
const fixedOrigin = /^[a-z][a-z\d+.-]*:\/\/[^/?#\\]+[/?#]/i;
// A scheme, possibly with a partial host: the rest still chooses the host.
const openHost = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*$/i;
// URL fields that never carry a host.
const pathOnlyFields = new Set(['pathname', 'search', 'hash']);
// Const aliases followed before giving up.
const maxAliasDepth = 4;

// A leading slash alone leaves open whether the following component starts a network path.
function beginsLocalPath(text) {
  return text.startsWith('/') && text.charCodeAt(1) > 0x20 && text[1] !== '/' && text[1] !== '\\';
}

// `textAfterBase` is the literal text since the last clean runtime piece (env, config, `req.protocol`), or undefined.
function partAfter(prefix, textAfterBase) {
  if (fixedOrigin.test(prefix) || beginsLocalPath(prefix)) return 'path';
  if (textAfterBase !== undefined && beginsLocalPath(textAfterBase)) return 'path';
  if (openHost.test(prefix)) return 'host';
  return 'whole';
}

function literalText(node, checker, strip, depth = 0) {
  const value = strip(node);
  if (!value || depth > maxAliasDepth) return;
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isIdentifier(value)) {
    const declaration = constantDeclaration(value, checker);
    return declaration && literalText(declaration.initializer, checker, strip, depth + 1);
  }
}

// Template spans or `+` operands, left to right, as { text } or { expression }.
function urlPieces(expression, checker, strip) {
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
      const text = literalText(operand, checker, strip);
      return text === undefined ? { expression: operand } : { text };
    });
  }
}

function constantDeclaration(node, checker) {
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  if (declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const)
    return declaration;
}

function isUrlConstructor(callee, checker) {
  if (!ts.isIdentifier(callee)) return false;
  const imported = importedFrom(callee, checker);
  if (imported) return imported.module === 'url' && imported.exported === 'URL';
  const declaration = checker.getSymbolAtLocation(callee)?.valueDeclaration;
  return callee.text === 'URL' && (!declaration || declaration.getSourceFile().isDeclarationFile);
}

// A direct call to a const formatter can prove the prefix despite dynamic substitutions in its return value.
function formatterPrefix(node, checker, strip, depth = 0) {
  const call = strip(node);
  if (!call || depth > maxAliasDepth) return;
  if (ts.isIdentifier(call)) {
    return formatterPrefix(constantDeclaration(call, checker)?.initializer, checker, strip, depth + 1);
  }
  if (!ts.isCallExpression(call)) return;
  const callee = strip(call.expression);
  if (!ts.isIdentifier(callee) || call.questionDotToken) return;
  let symbol = checker.getSymbolAtLocation(callee);
  if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !(declaration.parent.flags & ts.NodeFlags.Const))
    return;
  const fn = strip(declaration.initializer);
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return;
  if (fn.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.AsyncKeyword) || fn.asteriskToken) return;
  let returned = fn.body;
  if (ts.isBlock(returned)) {
    const [statement] = returned.statements;
    if (returned.statements.length !== 1 || !ts.isReturnStatement(statement)) return;
    returned = statement.expression;
  }
  const value = strip(returned);
  if (value) return literalText(value, checker, strip) ?? urlPieces(value, checker, strip)?.[0]?.text;
}

function createUrlControl(checker, trace, strip) {
  const tracedUrl = (node) => trace(node, 'url');

  function urlInstance(node, depth) {
    const expression = strip(node);
    if (!expression || depth > maxAliasDepth) return false;
    if (ts.isNewExpression(expression)) return isUrlConstructor(strip(expression.expression), checker);
    if (!ts.isIdentifier(expression)) return false;
    return urlInstance(constantDeclaration(expression, checker)?.initializer, depth + 1);
  }

  function piecesControl(pieces, depth) {
    let prefix = '';
    // Literal text after the last clean runtime piece, or undefined while every piece so far is literal.
    let textAfterBase;
    for (const piece of pieces) {
      if (piece.text !== undefined) {
        if (textAfterBase === undefined) prefix += piece.text;
        else textAfterBase += piece.text;
        continue;
      }
      const traced = tracedUrl(piece.expression);
      if (!traced) {
        if (!prefix && textAfterBase === undefined) prefix = formatterPrefix(piece.expression, checker, strip) ?? '';
        textAfterBase = '';
        continue;
      }
      // A traced first piece can itself be a whole URL.
      if (!prefix && textAfterBase === undefined) return control(piece.expression, depth + 1);
      return { part: partAfter(prefix, textAfterBase), trace: traced };
    }
  }

  function control(node, depth) {
    const expression = strip(node);
    if (!expression) return;
    if (depth > maxAliasDepth) {
      const traced = tracedUrl(expression);
      return traced && { part: 'whole', trace: traced };
    }
    if (ts.isIdentifier(expression)) {
      // A guard on the alias (`if (!ALLOWED.includes(next)) return`) cleans it even though its initializer is not.
      if (!tracedUrl(expression)) return;
      const declaration = constantDeclaration(expression, checker);
      if (declaration) return control(declaration.initializer, depth + 1);
    }
    if (ts.isPropertyAccessExpression(expression) && urlInstance(expression.expression, depth + 1)) {
      if (pathOnlyFields.has(expression.name.text)) {
        const traced = tracedUrl(expression);
        return (
          traced && { part: 'path', trace: traced, ...(expression.name.text === 'pathname' && { rawPathname: true }) }
        );
      }
      if (expression.name.text === 'href') return control(expression.expression, depth + 1);
    }
    if (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === 'toString' &&
      urlInstance(expression.expression.expression, depth + 1)
    )
      return control(expression.expression.expression, depth + 1);
    if (ts.isNewExpression(expression) && isUrlConstructor(strip(expression.expression), checker))
      return newUrlControl(expression, depth);
    const pieces = urlPieces(expression, checker, strip);
    if (pieces) return piecesControl(pieces, depth);
    const traced = tracedUrl(expression);
    if (!traced) return;
    const prefix = ts.isCallExpression(expression) && formatterPrefix(expression, checker, strip);
    return { part: prefix ? partAfter(prefix) : 'whole', trace: traced };
  }

  // `new URL(input, base)`: an absolute input replaces the base, so input decides the host unless it starts as a path.
  function newUrlControl(expression, depth) {
    const [input, base] = expression.arguments ?? [];
    if (!input) return;
    const fromInput = control(input, depth + 1);
    const initialText = literalText(input, checker, strip) ?? urlPieces(strip(input), checker, strip)?.[0]?.text;
    if (fromInput && (fromInput.part !== 'path' || fromInput.rawPathname)) return fromInput;
    if (initialText && fixedOrigin.test(initialText)) return fromInput;
    return (base && control(base, depth + 1)) ?? fromInput;
  }

  return (expression) => control(expression, 0);
}

module.exports = { createUrlControl, isUrlConstructor };
