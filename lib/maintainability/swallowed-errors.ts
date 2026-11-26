import ts from 'typescript';
import { walkNodes } from './walk.js';
import { testSourcePattern } from './snapshot-context.js';
import { generatedSource } from './duplicates.js';
import type {
  Block,
  CallExpression,
  CatchClause,
  Expression,
  Node,
  ParameterDeclaration,
  SignatureDeclaration,
  SourceFile,
  Statement,
  TryStatement,
} from 'typescript';
import type { Finding } from '../shared/types.js';

// Static assets and bundled third-party code are copied as they are, not maintained here.
const vendoredFolder = /(?:^|\/)(?:vendors?|third[-_]party|assets)\//i;
const loggerNames = new Set(['console', 'logger', 'log']);
const cleanupMethods = new Set([
  'close',
  'destroy',
  'release',
  'rollback',
  'disconnect',
  'end',
  'unlink',
  'rm',
  'kill',
]);

function callOf(statement: Statement): CallExpression | undefined {
  if (!ts.isExpressionStatement(statement)) return;
  const expression = ts.isAwaitExpression(statement.expression)
    ? statement.expression.expression
    : statement.expression;
  return ts.isCallExpression(expression) ? expression : undefined;
}

// Parentheses, casts and non-null assertions do not change which function is called.
function withoutWrappers(expression: Expression): Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  )
    expression = expression.expression;
  return expression;
}

// Names along a call's receiver chain, base first: `this.logger.warn(...)` gives ['this', 'logger',
// 'warn'].
function calleeNames(call: CallExpression): string[] {
  const names: string[] = [];
  let receiver = withoutWrappers(call.expression);
  while (ts.isPropertyAccessExpression(receiver)) {
    names.unshift(receiver.name.text);
    receiver = withoutWrappers(receiver.expression);
  }
  if (ts.isIdentifier(receiver)) names.unshift(receiver.text);
  else if (receiver.kind === ts.SyntaxKind.ThisKeyword) names.unshift('this');
  return names;
}

function isLoggingCall(statement: Statement) {
  const call = callOf(statement);
  if (!call) return false;
  const [base, owner] = calleeNames(call);
  return loggerNames.has(base) || (base === 'this' && /^_?(?:logger|log)$/i.test(owner ?? ''));
}

function isCleanupCall(statement: Statement) {
  const call = callOf(statement);
  return call !== undefined && cleanupMethods.has(calleeNames(call).at(-1) ?? '');
}

// Comments can follow the opening brace or any statement, on the same line or the next.
function hasComment(sourceFile: SourceFile, block: Block): boolean {
  const text = sourceFile.text;
  const positions = [block.getStart(sourceFile) + 1, ...block.statements.map((statement: Statement) => statement.end)];
  return positions.some(
    (position) =>
      ts.getLeadingCommentRanges(text, position)?.length || ts.getTrailingCommentRanges(text, position)?.length,
  );
}

// `try { require('optional-dependency') } catch {}` is how an optional feature is detected.
function probesOptionalModule(tryBlock: Block): boolean {
  let found = false;
  walkNodes(tryBlock, (node: Node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require'))
      found = true;
  });
  return found;
}

// A failed cleanup in a finally or catch block must not hide the error that is already propagating.
function insideCleanupPath(node: Node) {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return false;
    if (ts.isCatchClause(parent) || (ts.isTryStatement(parent) && parent.finallyBlock === child)) return true;
  }
  return false;
}

// A per-item log inside a loop is a common way to keep going, so only a later statement in the same
// block counts.
function continuesAfter(tryStatement: TryStatement): boolean {
  const parent = tryStatement.parent;
  if (!ts.isBlock(parent) && !ts.isSourceFile(parent)) return false;
  return parent.statements.indexOf(tryStatement) < parent.statements.length - 1;
}

function declaresWithDefault(statement: Statement, name: string): boolean {
  return (
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer,
    )
  );
}

// Statements of a try block, looking through blocks and ifs, when nothing but plain assignments to
// names happen.
function plainAssignments(statements: readonly Statement[]): string[] | undefined {
  const assignments: string[] = [];
  for (const statement of statements) {
    if (ts.isBlock(statement)) {
      const inner = plainAssignments(statement.statements);
      if (!inner) return;
      assignments.push(...inner);
    } else if (ts.isIfStatement(statement) && !statement.elseStatement) {
      const inner = plainAssignments([statement.thenStatement]);
      if (!inner) return;
      assignments.push(...inner);
    } else if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(statement.expression.left)
    )
      assignments.push(statement.expression.left.text);
    else return;
  }
  return assignments;
}

// `let font = fallback; try { font = load(); } catch {}`: the failure leaves the declared fallback
// in place.
function assignsOverDefault(tryStatement: TryStatement): boolean {
  const targets = plainAssignments(tryStatement.tryBlock.statements);
  if (!targets?.length || !ts.isBlock(tryStatement.parent)) return false;
  const earlier = tryStatement.parent.statements.slice(0, tryStatement.parent.statements.indexOf(tryStatement));
  return targets.every((target) => earlier.some((statement: Statement) => declaresWithDefault(statement, target)));
}

function nextStatement(statement: Statement): Statement | undefined {
  const parent = statement.parent;
  if (!ts.isBlock(parent) && !ts.isSourceFile(parent)) return;
  return parent.statements[parent.statements.indexOf(statement) + 1];
}

// `try { ... } catch {} return null;`: the caller receives a typed fallback result.
function returnsEmptyAfter(tryStatement: TryStatement): boolean {
  const next = nextStatement(tryStatement);
  if (!next || !ts.isReturnStatement(next)) return false;
  const value = next.expression && withoutWrappers(next.expression);
  return (
    !value ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isNumericLiteral(value) && value.text === '0') ||
    (ts.isStringLiteralLike(value) && value.text === '') ||
    (ts.isArrayLiteralExpression(value) && value.elements.length === 0) ||
    (ts.isObjectLiteralExpression(value) && value.properties.length === 0) ||
    (ts.isIdentifier(value) && (value.text === 'undefined' || /(?:fallback|default)/i.test(value.text)))
  );
}

function enclosingFunction(node: Node): SignatureDeclaration | undefined {
  let current: Node | undefined = node.parent;
  while (current && !ts.isFunctionLike(current)) current = current.parent;
  return current;
}

function returnsOnSuccess(tryBlock: Block): boolean {
  const owner = enclosingFunction(tryBlock);
  let found = false;
  walkNodes(tryBlock, (node: Node) => {
    if (ts.isReturnStatement(node) && enclosingFunction(node) === owner) found = true;
  });
  return found;
}

// `try { return parse(); } catch {} throw new Error()`, or a loop that tries each server and throws
// once all have
// failed: the failure still reaches the caller.
function throwsAfter(tryStatement: TryStatement): boolean {
  const body = tryStatement.parent;
  const loop =
    ts.isBlock(body) && ts.isIterationStatement(body.parent, false) && returnsOnSuccess(tryStatement.tryBlock)
      ? body.parent
      : undefined;
  return [tryStatement, loop].some((statement) => {
    const next = statement && nextStatement(statement);
    return next !== undefined && ts.isThrowStatement(next);
  });
}

// `while (true)` / `for (;;)`: the loop can only be left by returning, so no failure falls through
// to later code.
function isEndlessLoop(loop: Node): boolean {
  if (ts.isForStatement(loop)) return !loop.condition;
  return ts.isWhileStatement(loop) && loop.expression.kind === ts.SyntaxKind.TrueKeyword;
}

// A polling loop that returns from the try retries after a failure, so the log is the per-attempt
// record.
function retriesInLoop(tryStatement: TryStatement): boolean {
  const body = tryStatement.parent;
  return ts.isBlock(body) && isEndlessLoop(body.parent) && returnsOnSuccess(tryStatement.tryBlock);
}

// `(req, res, next) => { try { prepare(); } catch { log } next(); }`: middleware that cannot
// prepare its extra work still passes the request on.
function passesToNext(tryStatement: TryStatement): boolean {
  const next = nextStatement(tryStatement);
  const call = next && callOf(next);
  if (!call || !ts.isIdentifier(call.expression) || call.expression.text !== 'next') return false;
  const owner = enclosingFunction(tryStatement);
  return Boolean(owner?.parameters.some((parameter: ParameterDeclaration) => parameter.name.getText() === 'next'));
}

// A cache read or write that fails falls back to the source of truth, so only cache calls may be
// awaited.
function onlyAwaitsCache(tryBlock: Block): boolean {
  const awaited: Expression[] = [];
  walkNodes(tryBlock, (node: Node) => {
    if (ts.isAwaitExpression(node)) awaited.push(withoutWrappers(node.expression));
  });
  return (
    awaited.length > 0 &&
    awaited.every(
      (expression) => ts.isCallExpression(expression) && calleeNames(expression).some((name) => /cache/i.test(name)),
    )
  );
}

const fallbackWording =
  /\b(?:continu|without\b|will recover|fall(?:ing|s)? ?back|skipp|best[- ]effort|ignor|non[- ]blocking|will retry|waiting for)/i;

function messageText(call: CallExpression): string {
  const parts: string[] = [];
  walkNodes(call, (node: Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) parts.push(node.text);
  });
  return parts.join(' ');
}

// `logger.warn('refresh failed, the existing token will continue to work')` explains the fallback
// like a comment.
function logExplainsFallback(statements: readonly Statement[]): boolean {
  return statements.some((statement: Statement) => {
    const call = callOf(statement);
    return call !== undefined && fallbackWording.test(messageText(call));
  });
}

function onlySerializesTelemetry(tryBlock: Block): boolean {
  if (!tryBlock.statements.length) return false;
  let hasStringify = false;
  let hasOtherCall = false;
  walkNodes(tryBlock, (node: Node) => {
    if (!ts.isCallExpression(node)) return;
    const names = calleeNames(node);
    if (names.join('.') === 'JSON.stringify') hasStringify = true;
    else if (!loggerNames.has(names[0]) && !(names[0] === 'this' && /^_?(?:logger|log)$/i.test(names[1] ?? '')))
      hasOtherCall = true;
  });
  return hasStringify && !hasOtherCall;
}

function swallowKind(sourceFile: SourceFile, clause: CatchClause): 'empty' | 'logs' | undefined {
  const tryStatement = clause.parent;
  const statements = clause.block.statements;
  if (hasComment(sourceFile, clause.block)) return;
  // A comment directly above the try, such as "non-blocking", explains the catch just as well.
  if (ts.getLeadingCommentRanges(sourceFile.text, tryStatement.pos)?.length) return;
  if (probesOptionalModule(tryStatement.tryBlock) || insideCleanupPath(tryStatement)) return;
  if (tryStatement.tryBlock.statements.length && tryStatement.tryBlock.statements.every(isCleanupCall)) return;
  if (assignsOverDefault(tryStatement) || throwsAfter(tryStatement) || returnsEmptyAfter(tryStatement)) return;
  if (retriesInLoop(tryStatement) || passesToNext(tryStatement)) return;
  if (onlyAwaitsCache(tryStatement.tryBlock) || onlySerializesTelemetry(tryStatement.tryBlock)) return;
  if (!statements.length) return 'empty';
  if (statements.every(isLoggingCall) && continuesAfter(tryStatement) && !logExplainsFallback(statements))
    return 'logs';
}

// Input that is not valid JSON or base64 usually just means "no value supplied", so the default
// stays in use.
function parsesInput(tryBlock: Block): boolean {
  let found = false;
  walkNodes(tryBlock, (node: Node) => {
    if (!ts.isCallExpression(node)) return;
    const names = calleeNames(node);
    if (names.join('.') === 'JSON.parse' || ['atob', 'decodeURIComponent'].includes(names[0])) found = true;
  });
  return found;
}

const advice =
  ' The failure is hidden from the caller, so the code carries on as if it had succeeded. Rethrow, return an error value, record a failure status, or add a comment saying why ignoring the error is safe.';

function checkSwallowedErrors(sourceFile: SourceFile, file: string): Finding[] {
  if (
    testSourcePattern.test(file) ||
    vendoredFolder.test(file.replaceAll('\\', '/')) ||
    generatedSource(sourceFile, file)
  )
    return [];
  const findings: Finding[] = [];
  walkNodes(sourceFile, (node: Node) => {
    if (!ts.isCatchClause(node)) return;
    const kind = swallowKind(sourceFile, node);
    if (!kind) return;
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      file,
      line: position.line + 1,
      column: position.character + 1,
      ruleId: 'swallowed-error',
      message:
        (kind === 'empty'
          ? 'This catch block is empty.'
          : 'This catch block only logs the error and the code after it continues.') + advice,
      ...(kind === 'logs' &&
        parsesInput(node.parent.tryBlock) && {
          contextualReason:
            'The try block parses input, so the logged failure may just mean no valid value was supplied.',
        }),
    });
  });
  return findings;
}

export { checkSwallowedErrors };
