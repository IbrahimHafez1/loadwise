import { ts } from '../../performance/compiler.js';
import { importedFrom } from '../bindings.js';
import type { Expression, NewExpression, Node, VariableDeclaration } from 'typescript';
import type { CheckerAdapter, TaintApi, UrlControl } from '../../shared/types.js';

// The `stripExpression` of bindings.cjs: removes parentheses, assertions and `await`.
interface StripExpression {
  (node: Expression): Expression;
  (node: Expression | undefined): Expression | undefined;
}

interface LiteralPiece {
  text: string;
}

interface DynamicPiece {
  expression: Expression;
}

// Template spans or `+` operands: literal text, or an expression whose value is only known at run
// time.
type UrlPiece = LiteralPiece | DynamicPiece;

// A scheme and a complete host followed by a path, query or fragment: the rest cannot change the
// host.
const fixedOrigin = /^[a-z][a-z\d+.-]*:\/\/[^/?#\\]+[/?#]/i;
// A relative reference whose first path segment or query start is literal: `./callback?`,
// `original?`, `../login#`. Without a leading slash or scheme it resolves against the current URL,
// so the rest cannot choose a host.
const relativeReference = /^(?:[\w.~-]+[/?#]|[?#])/;
// A scheme, possibly with a partial host: the rest still chooses the host.
const openHost = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*$/i;
// URL fields that never carry a host.
const pathOnlyFields = new Set(['pathname', 'search', 'hash']);
// Const aliases followed before giving up.
const maxAliasDepth = 4;

// A leading slash alone leaves open whether the following component starts a network path.
function beginsLocalPath(text: string) {
  return text.startsWith('/') && text.charCodeAt(1) > 0x20 && text[1] !== '/' && text[1] !== '\\';
}

// `textAfterBase` is the literal text since the last clean runtime piece (env, config,
// `req.protocol`), or undefined.
function partAfter(prefix: string, textAfterBase?: string): string {
  if (fixedOrigin.test(prefix) || beginsLocalPath(prefix) || relativeReference.test(prefix)) return 'path';
  if (textAfterBase !== undefined && (textAfterBase === '/' || beginsLocalPath(textAfterBase))) return 'path';
  if (openHost.test(prefix)) return 'host';
  return 'whole';
}

function literalText(
  node: Expression | undefined,
  checker: CheckerAdapter,
  strip: StripExpression,
  depth = 0,
): string | undefined {
  const value = strip(node);
  if (!value || depth > maxAliasDepth) return;
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isIdentifier(value)) {
    const declaration = constantDeclaration(value, checker);
    return declaration && literalText(declaration.initializer, checker, strip, depth + 1);
  }
}

// Template spans or `+` operands, left to right, as { text } or { expression }.
function urlPieces(expression: Expression, checker: CheckerAdapter, strip: StripExpression): UrlPiece[] | undefined {
  if (ts.isTemplateExpression(expression)) {
    const pieces: UrlPiece[] = [{ text: expression.head.text }];
    for (const span of expression.templateSpans) {
      // `${API_ORIGIN}/files/${id}`: a constant string span is literal text, so it can fix the
      // origin.
      const text = literalText(span.expression, checker, strip);
      pieces.push(text === undefined ? { expression: span.expression } : { text }, { text: span.literal.text });
    }
    return pieces;
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const operands: Expression[] = [];
    let left: Expression = expression;
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

function constantDeclaration(node: Node, checker: CheckerAdapter): VariableDeclaration | undefined {
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  if (declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const)
    return declaration;
}

function singleBlockAssignment(
  declaration: VariableDeclaration,
  usage: Node,
  checker: CheckerAdapter,
): Expression | undefined {
  const init = declaration.initializer && stripEmpty(declaration.initializer);
  if (init !== '') return;
  const block = ts.findAncestor(declaration, ts.isBlock);
  if (!block || usage.pos < declaration.end || usage.end > block.end) return;
  const symbol = checker.getSymbolAtLocation(declaration.name);
  let assigned: Expression | undefined;
  let count = 0;
  (function visit(node: Node): void {
    // A compound write (`target += x`) also changes the value, so it rules out the shortcut.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left) &&
      node.end < usage.pos &&
      checker.getSymbolAtLocation(node.left) === symbol
    ) {
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) assigned = node.right;
      count++;
    }
    ts.forEachChild(node, visit);
  })(block);
  return count === 1 ? assigned : undefined;
}

function stripEmpty(node: Expression): string | undefined {
  const value = ts.skipOuterExpressions(node);
  return ts.isStringLiteralLike(value) ? value.text : undefined;
}

// The text a list of pieces starts with, when it starts with literal text: adjacent literal pieces
// read as one string, as they would in the source.
function leadingText(pieces: UrlPiece[] | undefined): string | undefined {
  let text: string | undefined;
  for (const piece of pieces ?? []) {
    if (!('text' in piece)) break;
    text = (text ?? '') + piece.text;
  }
  return text;
}

function isUrlConstructor(callee: Node, checker: CheckerAdapter): boolean {
  if (!ts.isIdentifier(callee)) return false;
  const imported = importedFrom(callee, checker);
  if (imported) return imported.module === 'url' && imported.exported === 'URL';
  const declaration = checker.getSymbolAtLocation(callee)?.valueDeclaration;
  return callee.text === 'URL' && (!declaration || declaration.getSourceFile().isDeclarationFile);
}

// A direct call to a const formatter can prove the prefix despite dynamic substitutions in its
// return value.
function formatterPrefix(
  node: Expression | undefined,
  checker: CheckerAdapter,
  strip: StripExpression,
  depth = 0,
): string | undefined {
  const call = strip(node);
  if (!call || depth > maxAliasDepth) return;
  if (ts.isIdentifier(call)) {
    return formatterPrefix(constantDeclaration(call, checker)?.initializer, checker, strip, depth + 1);
  }
  if (!ts.isCallExpression(call)) return;
  const callee = strip(call.expression);
  if (!ts.isIdentifier(callee) || call.questionDotToken) return;
  let symbol = checker.getSymbolAtLocation(callee);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !(declaration.parent.flags & ts.NodeFlags.Const))
    return;
  const fn = strip(declaration.initializer);
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return;
  if (fn.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.AsyncKeyword) || fn.asteriskToken) return;
  let returned: Expression | undefined;
  if (ts.isBlock(fn.body)) {
    const [statement] = fn.body.statements;
    if (fn.body.statements.length !== 1 || !ts.isReturnStatement(statement)) return;
    returned = statement.expression;
  } else {
    returned = fn.body;
  }
  const value = strip(returned);
  if (value) return literalText(value, checker, strip) ?? leadingText(urlPieces(value, checker, strip));
}

function createUrlControl(
  checker: CheckerAdapter,
  trace: TaintApi['trace'],
  strip: StripExpression,
): (expression: Expression) => UrlControl | undefined {
  const tracedUrl = (node: Expression) => trace(node, 'url');

  function urlInstance(node: Expression | undefined, depth: number): boolean {
    const expression = strip(node);
    if (!expression || depth > maxAliasDepth) return false;
    if (ts.isNewExpression(expression)) return isUrlConstructor(strip(expression.expression), checker);
    if (!ts.isIdentifier(expression)) return false;
    return urlInstance(constantDeclaration(expression, checker)?.initializer, depth + 1);
  }

  function piecesControl(pieces: UrlPiece[], depth: number): UrlControl | undefined {
    let prefix = '';
    // Literal text after the last clean runtime piece, or undefined while every piece so far is
    // literal.
    let textAfterBase: string | undefined;
    // Once a fixed origin or leading path separator has been crossed, subsequent clean path
    // segments cannot un-fix the origin.
    let pastOrigin = false;
    for (const piece of pieces) {
      if ('text' in piece) {
        if (textAfterBase === undefined) prefix += piece.text;
        else textAfterBase += piece.text;
        if (partAfter(prefix, textAfterBase) === 'path') pastOrigin = true;
        continue;
      }
      const traced = tracedUrl(piece.expression);
      if (!traced) {
        if (!prefix && textAfterBase === undefined) prefix = formatterPrefix(piece.expression, checker, strip) ?? '';
        if (partAfter(prefix, textAfterBase) === 'path') pastOrigin = true;
        textAfterBase = '';
        continue;
      }
      // A traced first piece can itself be a whole URL.
      if (!prefix && textAfterBase === undefined) return control(piece.expression, depth + 1);
      return { part: pastOrigin ? 'path' : partAfter(prefix, textAfterBase), trace: traced };
    }
  }

  function aliasTarget(expression: Expression): Expression | undefined {
    const declaration = constantDeclaration(expression, checker);
    if (declaration) return declaration.initializer;
    const rawDecl = checker.getSymbolAtLocation(expression)?.valueDeclaration;
    return rawDecl && ts.isVariableDeclaration(rawDecl)
      ? singleBlockAssignment(rawDecl, expression, checker)
      : undefined;
  }

  function control(node: Expression | undefined, depth: number): UrlControl | undefined {
    const expression = strip(node);
    if (!expression) return;
    if (depth > maxAliasDepth) {
      const traced = tracedUrl(expression);
      return traced && { part: 'whole', trace: traced };
    }
    if (ts.isIdentifier(expression)) {
      // A guard on the alias (`if (!ALLOWED.includes(next)) return`) cleans it even though its
      // initializer is not.
      if (!tracedUrl(expression)) return;
      const target = aliasTarget(expression);
      if (target) return control(target, depth + 1);
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

  // `new URL(input, base)`: an absolute input replaces the base, so input decides the host unless
  // it starts as a path.
  function newUrlControl(expression: NewExpression, depth: number): UrlControl | undefined {
    const [input, base] = expression.arguments ?? [];
    if (!input) return;
    const fromInput = control(input, depth + 1);
    const initialText = literalText(input, checker, strip) ?? leadingText(urlPieces(strip(input), checker, strip));
    if (fromInput && (fromInput.part !== 'path' || fromInput.rawPathname)) return fromInput;
    if (initialText && fixedOrigin.test(initialText)) return fromInput;
    return (base && control(base, depth + 1)) ?? fromInput;
  }

  return (expression: Expression) => control(expression, 0);
}

export { createUrlControl, isUrlConstructor };
