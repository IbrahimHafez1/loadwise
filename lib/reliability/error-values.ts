// Rules about what a catch block or a throw does with an error: a replacement error that drops the original, a thrown
// value that is not an Error, and a log line that keeps the message but loses the stack.
import { ts } from '../performance/compiler.js';
import { walkNodes } from './walk.js';
import { isIgnoredSource } from './source-helpers.js';
import { findingAt } from './resource-leaks.js';
import type { Block, CatchClause, Expression, Identifier, Node, SourceFile, ThrowStatement } from 'typescript';
import type { Finding } from '../shared/types.js';

// Only the built-in error classes: a domain or HTTP error (AppError, NotFoundException) usually translates a failure on
// purpose, while a plain Error thrown from a catch block is just a worse copy of the original.
const builtInError = /^(?:Error|TypeError|RangeError|SyntaxError|ReferenceError)$/;
// A failure level: a warning that drops the stack is usually a deliberate downgrade of an expected failure.
const failureLogMethods = new Set(['error', 'fatal']);
// Fixtures, end-to-end helpers, test utilities and one-off migrations throw and log loosely on purpose.
const looseFolder = /(?:^|\/)(?:__fixtures__|__mocks__|fixtures?|e2e|migrations?|[\w-]*test[\w-]*)\//i;
const loggerName = /^(?:console|_?logger|_?log)$/i;

function insideNestedFunction(node: Node, container: Node): boolean {
  for (let current = node.parent; current && current !== container; current = current.parent)
    if (ts.isFunctionLike(current)) return true;
  return false;
}

// Statements of the catch block itself, not of callbacks declared inside it.
function ownNodes(block: Block, visit: (node: Node) => void): void {
  walkNodes(block, (node: Node) => {
    if (node !== block && !insideNestedFunction(node, block)) visit(node);
  });
}

function caughtName(clause: CatchClause): string | undefined {
  const binding = clause.variableDeclaration?.name;
  return binding && ts.isIdentifier(binding) ? binding.text : undefined;
}

function mentions(root: Node, name: string): boolean {
  let found = false;
  walkNodes(root, (node: Node) => {
    if (ts.isIdentifier(node) && node.text === name) found = true;
  });
  return found;
}

function constructedName(expression: Expression): string | undefined {
  const callee = ts.isNewExpression(expression) ? expression.expression : undefined;
  if (!callee) return;
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

function checkRethrowWithoutCause(clause: CatchClause, sourceFile: SourceFile, file: string, findings: Finding[]) {
  const name = caughtName(clause);
  // An underscore name says the value is unused on purpose; any other use in the block means the code looked at it.
  if (name === undefined || name.startsWith('_') || mentions(clause.block, name)) return;
  // A block that does anything besides throw (reports to the user, cleans up) is translating the failure on purpose.
  const [statement] = clause.block.statements;
  if (clause.block.statements.length !== 1 || !ts.isThrowStatement(statement) || !statement.expression) return;
  const created = constructedName(statement.expression);
  if (created !== undefined && builtInError.test(created))
    findings.push(
      findingAt(
        sourceFile,
        file,
        statement,
        'error-rethrown-without-cause',
        `This throws a new ${created} from a catch block without the caught error, so the original message and stack are lost. Pass it as \`{ cause: ${name} }\`.`,
      ),
    );
}

function isErrorValue(expression: Expression): string | undefined {
  const value = ts.skipOuterExpressions(expression);
  if (ts.isStringLiteralLike(value) || ts.isTemplateExpression(value)) return 'a string';
  if (ts.isNumericLiteral(value) || ts.isBigIntLiteral(value)) return 'a number';
  if (ts.isObjectLiteralExpression(value)) return 'an object literal';
  if (ts.isArrayLiteralExpression(value)) return 'an array';
  if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) return 'a boolean';
  if (value.kind === ts.SyntaxKind.NullKeyword) return 'null';
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return isErrorValue(value.left) === 'a string' || isErrorValue(value.right) === 'a string' ? 'a string' : undefined;
  return undefined;
}

function checkThrowNonError(node: ThrowStatement, sourceFile: SourceFile, file: string, findings: Finding[]) {
  const kind = node.expression && isErrorValue(node.expression);
  if (!kind) return;
  findings.push(
    findingAt(
      sourceFile,
      file,
      node,
      'throw-non-error',
      `This throws ${kind}, which has no stack trace and fails \`instanceof Error\` checks. Throw an Error (or a subclass) instead.`,
    ),
  );
}

function isFailureLog(node: Node): boolean {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  if (!failureLogMethods.has(node.expression.name.text)) return false;
  let receiver = ts.skipOuterExpressions(node.expression.expression);
  while (ts.isPropertyAccessExpression(receiver)) {
    if (loggerName.test(receiver.name.text)) return true;
    receiver = ts.skipOuterExpressions(receiver.expression);
  }
  return ts.isIdentifier(receiver) && loggerName.test(receiver.text);
}

function isMessageRead(reference: Identifier): boolean {
  const access = reference.parent;
  return ts.isPropertyAccessExpression(access) && access.expression === reference && access.name.text === 'message';
}

function enclosingFailureLog(reference: Node, block: Block): Node | undefined {
  for (let current: Node | undefined = reference; current && current !== block; current = current.parent)
    if (isFailureLog(current)) return current;
}

function exitsOrThrows(block: Block): boolean {
  let exits = false;
  ownNodes(block, (node: Node) => {
    if (ts.isThrowStatement(node)) exits = true;
    if (ts.isCallExpression(node) && node.expression.getText() === 'process.exit') exits = true;
  });
  return exits;
}

function checkLoggedWithoutStack(clause: CatchClause, sourceFile: SourceFile, file: string, findings: Finding[]) {
  const name = caughtName(clause);
  if (name === undefined || exitsOrThrows(clause.block)) return;
  const references: Identifier[] = [];
  walkNodes(clause.block, (node: Node) => {
    const isPropertyName = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
    if (ts.isIdentifier(node) && node.text === name && !isPropertyName) references.push(node);
  });
  if (!references.length || !references.every(isMessageRead)) return;
  const logged = references.map((reference) => enclosingFailureLog(reference, clause.block)).find(Boolean);
  if (!logged) return;
  findings.push(
    findingAt(
      sourceFile,
      file,
      logged,
      'error-logged-without-stack',
      `This catch block logs only ${name}.message and carries on, so the stack trace and any cause are lost. Log the error itself (for example \`logger.error({ err: ${name} }, ...)\`) or rethrow it.`,
    ),
  );
}

function checkErrorValues(sourceFile: SourceFile, file: string): Finding[] {
  if (isIgnoredSource(sourceFile, file) || looseFolder.test(file.replaceAll('\\', '/'))) return [];
  const findings: Finding[] = [];
  walkNodes(sourceFile, (node: Node) => {
    if (ts.isCatchClause(node)) {
      checkRethrowWithoutCause(node, sourceFile, file, findings);
      checkLoggedWithoutStack(node, sourceFile, file, findings);
    } else if (ts.isThrowStatement(node)) checkThrowNonError(node, sourceFile, file, findings);
  });
  return findings;
}

export { checkErrorValues };
