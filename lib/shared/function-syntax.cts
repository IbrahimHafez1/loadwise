// Syntax helpers over project functions (own nodes, returns, value leaves, stand-in sinks) used by
// function-summaries.
import { loadSyntax } from '../performance/compiler.cjs';
import { isProjectSource } from '../security/taint/summaries.cjs';
import { strip } from '../security/request-forgery/shared.cjs';
import type { Block, Expression, Identifier, Node, ReturnStatement, Statement, VariableDeclaration } from 'typescript';
import type { FunctionWithBody } from './types/function-summaries.cjs';
const ts = loadSyntax();

/** A `const` with an identifier name and an initializer. */
export type ConstDeclaration = VariableDeclaration & { name: Identifier; initializer: Expression };

export function isProjectFunction(declaration: Node | undefined): declaration is FunctionWithBody {
  return (
    !!declaration &&
    ts.isFunctionLike(declaration) &&
    'body' in declaration &&
    !!declaration.body &&
    isProjectSource(declaration.getSourceFile())
  );
}

export function functionLabel(fn: FunctionWithBody): string {
  let name = 'name' in fn && fn.name && ts.isIdentifier(fn.name) ? fn.name.text : undefined;
  if (!name && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) name = fn.parent.name.text;
  const owner = ts.isClassLike(fn.parent) && fn.parent.name ? `${fn.parent.name.text}.` : '';
  return owner + (name ?? 'anonymous');
}

export function isConst(declaration: Node): declaration is ConstDeclaration {
  return (
    ts.isVariableDeclaration(declaration) &&
    !!(declaration.parent.flags & ts.NodeFlags.Const) &&
    ts.isIdentifier(declaration.name) &&
    !!declaration.initializer
  );
}

// Visits `fn`'s own body, skipping nested functions.
export function forEachOwnNode(fn: FunctionWithBody, visit: (node: Node) => void): void {
  (function walk(node: Node): void {
    if (node !== fn && ts.isFunctionLike(node)) return;
    visit(node);
    ts.forEachChild(node, walk);
  })(fn.body);
}

export function returnStatements(fn: FunctionWithBody): ReturnStatement[] {
  const returns: ReturnStatement[] = [];
  forEachOwnNode(fn, (node: Node) => {
    if (ts.isReturnStatement(node)) returns.push(node);
  });
  return returns;
}

export function fallsThrough(body: Block): boolean {
  const last = body.statements.at(-1);
  return !last || !(ts.isReturnStatement(last) || ts.isThrowStatement(last));
}

// The values a returned expression can take: both branches of a conditional, without wrappers or
// await.
export function valueLeaves(expression: Expression): Expression[] {
  const value = strip(expression);
  if (value && ts.isConditionalExpression(value))
    return [...valueLeaves(value.whenTrue), ...valueLeaves(value.whenFalse)];
  return value ? [value] : [];
}

export function isLiteralValue(node: Node): boolean {
  return (
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === 'undefined')
  );
}

export const isBooleanLiteral = (node: Node, value: boolean): boolean =>
  node.kind === (value ? ts.SyntaxKind.TrueKeyword : ts.SyntaxKind.FalseKeyword);

// Sink recognisers judge a use by the guards between it and the function start. The end of a body
// and the true branch of a returned condition have no node of their own, so these stand-ins are
// placed there.
export function endOfBodySink(fn: FunctionWithBody, body: Block): Statement {
  const sink = ts.factory.createEmptyStatement();
  const block = ts.factory.createBlock([...body.statements, sink]);
  Object.assign(block, { parent: fn });
  return standIn(sink, block, body.end);
}

export function whenTrueSink(condition: Expression): Statement {
  const sink = ts.factory.createEmptyStatement();
  const branch = ts.factory.createIfStatement(condition, sink);
  Object.assign(branch, { parent: condition });
  return standIn(sink, branch, condition.end);
}

// A statement that exists only at `position`, so the recognisers can ask what guards that point.
export function standIn(statement: Statement, parent: Node, position: number): Statement {
  return Object.assign(statement, {
    parent,
    pos: position,
    end: position,
    getStart: () => position,
    getSourceFile: () => parent.parent.getSourceFile(),
  });
}
