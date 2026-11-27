import ts from 'typescript';
import { walkNodes } from './walk.js';
import { hasModifier } from './modifiers.js';
import { generatedSource } from './duplicates.js';
import { classifyExecutionContext, isVendoredMinified } from '../shared/execution-context.js';
import {
  NO_CONSOLE_RULES,
  eslintDisabledLines,
  isBundledLibrary,
  isVendoredOrSamplePath,
} from './source-exclusions.js';
import type { CallExpression, CompilerOptions, Expression, Node, SourceFile } from 'typescript';
import type { Finding } from '../shared/types.js';

const CONSOLE_METHODS = new Set(['log', 'info', 'debug', 'warn', 'error', 'trace', 'dir', 'table']);
// Output of these methods goes to stderr; the rest goes to stdout.
const STDERR_METHODS = new Set(['warn', 'error', 'trace']);

// Files that are run once by hand or by a tool, where printing is the point. Matched against the
// project-relative path the scan reports, so directories above the project root never count.
const NON_PRODUCTION_PATH =
  /(?:^|\/)(?:seeds?|seeders?|migrations?|scripts?|bin|cli|commands?|tools?|tests?|__tests__|bench|benchmarks?|fixtures?|examples?|playground|stories)\/|\.stories\.[cm]?[jt]sx?$|\.config\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/i;
// Frontend folders hold code that runs in a browser, which this rule leaves alone.
const FRONTEND_PATH = /(?:^|\/)(?:client|frontend|web|browser|public|static|ui|components|views|hooks|composables)\//i;
const BROWSER_GLOBALS = new Set(['window', 'document']);
const LOGGER_FILE_NAME = /^(?:logger|log|logging|[\w-]*[.-]logger)$/i;
const LOGGER_IMPLEMENTATION_NAME = /^(?:log|logger|createLogger|makeLogger|getLogger|\w*Logger)$/i;
const LAST_RESORT_EVENTS = new Set(['uncaughtException', 'unhandledRejection', 'uncaughtExceptionMonitor']);
const ERROR_BOUNDARY_METHODS = new Set(['componentDidCatch', 'getDerivedStateFromError']);

const DEV_WHEN_TRUE =
  /^(?:__DEV__|import\.meta\.env\.DEV|process\.env\.NODE_ENV!==?['"]production['"]|process\.env\.NODE_ENV===?['"](?:development|dev)['"])$/;
const DEV_WHEN_FALSE =
  /^(?:import\.meta\.env\.PROD|process\.env\.NODE_ENV===?['"]production['"]|process\.env\.NODE_ENV!==?['"](?:development|dev)['"])$/;

type DevPolarity = 'dev-when-true' | 'dev-when-false';

const FIXABLE_METHODS: Record<string, string> = {
  log: 'info',
  info: 'info',
  debug: 'debug',
  warn: 'warn',
  error: 'error',
};
const NEST_METHODS: Record<string, string> = { log: 'log', info: 'log', debug: 'debug', warn: 'warn', error: 'error' };

function consoleMethodOf(node: Node): string | undefined {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
  const { expression, name } = node.expression;
  if (!ts.isIdentifier(expression) || expression.text !== 'console') return;
  return CONSOLE_METHODS.has(name.text) ? name.text : undefined;
}

function loggerCandidateName(node: Node): string | undefined {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isPropertyDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }
  return undefined;
}

// A file that defines a logger is the one place allowed to reach the console.
function definesLogger(sourceFile: SourceFile, file: string): boolean {
  const baseName =
    file
      .replaceAll('\\', '/')
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '') ?? '';
  if (LOGGER_FILE_NAME.test(baseName)) return true;
  return sourceFile.statements.some((statement) => {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      return LOGGER_IMPLEMENTATION_NAME.test(loggerCandidateName(statement) ?? '');
    }
    if (!ts.isVariableStatement(statement) || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return false;
    return statement.declarationList.declarations.some((declaration) =>
      LOGGER_IMPLEMENTATION_NAME.test(loggerCandidateName(declaration) ?? ''),
    );
  });
}

function unwrapParentheses(expression: Expression): Expression {
  return ts.isParenthesizedExpression(expression) ? unwrapParentheses(expression.expression) : expression;
}

function devPolarity(condition: Expression, sourceFile: SourceFile): DevPolarity | undefined {
  const expression = unwrapParentheses(condition);
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = devPolarity(expression.operand, sourceFile);
    if (!inner) return;
    return inner === 'dev-when-true' ? 'dev-when-false' : 'dev-when-true';
  }
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind;
    const sides = [devPolarity(expression.left, sourceFile), devPolarity(expression.right, sourceFile)];
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken && sides.includes('dev-when-true')) return 'dev-when-true';
    if (operator === ts.SyntaxKind.BarBarToken && sides.includes('dev-when-false')) return 'dev-when-false';
  }
  const text = expression.getText(sourceFile).replaceAll(/\s+/g, '');
  if (DEV_WHEN_TRUE.test(text)) return 'dev-when-true';
  return DEV_WHEN_FALSE.test(text) ? 'dev-when-false' : undefined;
}

function isInDevGuard(node: Node, sourceFile: SourceFile): boolean {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent) && child !== parent.expression) {
      const polarity = devPolarity(parent.expression, sourceFile);
      if (polarity === (child === parent.thenStatement ? 'dev-when-true' : 'dev-when-false')) return true;
    } else if (ts.isConditionalExpression(parent) && child !== parent.condition) {
      const polarity = devPolarity(parent.condition, sourceFile);
      if (polarity === (child === parent.whenTrue ? 'dev-when-true' : 'dev-when-false')) return true;
    } else if (
      ts.isBinaryExpression(parent) &&
      child === parent.right &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      devPolarity(parent.left, sourceFile) === 'dev-when-true'
    ) {
      return true;
    }
  }
  return false;
}

function isInsideLoggerImplementationOrBoundary(node: Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    const name = loggerCandidateName(current);
    if (name && (LOGGER_IMPLEMENTATION_NAME.test(name) || ERROR_BOUNDARY_METHODS.has(name))) return true;
  }
  return false;
}

function isProcessEventHandler(fn: Node): boolean {
  const call = fn.parent;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false;
  const { expression, name } = call.expression;
  if (!ts.isIdentifier(expression) || expression.text !== 'process') return false;
  if (!['on', 'once', 'addListener'].includes(name.text)) return false;
  const [event] = call.arguments;
  return Boolean(event && ts.isStringLiteralLike(event) && LAST_RESORT_EVENTS.has(event.text));
}

function unwrapStatementExpression(expression: Expression): Expression {
  const unwrapped = unwrapParentheses(expression);
  if (ts.isVoidExpression(unwrapped) || ts.isAwaitExpression(unwrapped)) {
    return unwrapStatementExpression(unwrapped.expression);
  }
  return unwrapped;
}

// `main().catch(error => console.error(error))` as a top-level statement reports why the program died.
function isProgramEntryCatch(node: Node, sourceFile: SourceFile): boolean {
  const catchCall = ts.findAncestor(
    node,
    (candidate): candidate is CallExpression =>
      ts.isCallExpression(candidate) &&
      ts.isPropertyAccessExpression(candidate.expression) &&
      candidate.expression.name.text === 'catch' &&
      candidate.arguments.some((argument) => argument.pos <= node.pos && node.end <= argument.end),
  );
  if (!catchCall) return false;
  const statement = ts.findAncestor(catchCall, (candidate) => candidate.parent === sourceFile);
  return Boolean(
    statement && ts.isExpressionStatement(statement) && unwrapStatementExpression(statement.expression) === catchCall,
  );
}

function isLastResortReport(node: Node, sourceFile: SourceFile): boolean {
  const handler = ts.findAncestor(node, (candidate) => ts.isFunctionLike(candidate));
  if (handler && isProcessEventHandler(handler)) return true;
  return isProgramEntryCatch(node, sourceFile);
}

function isServerCode(sourceFile: SourceFile, options: CompilerOptions): boolean {
  const { runtime } = classifyExecutionContext(sourceFile, { getCompilerOptions: () => options });
  // 'unknown' files give no sign of where the output goes, so they are left alone.
  return runtime === 'node-server';
}

function isProcessMember(node: Node, member: string): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === member
  );
}

function isBrowserGlobalUse(node: Node): boolean {
  return (
    ts.isIdentifier(node) &&
    BROWSER_GLOBALS.has(node.text) &&
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.expression === node
  );
}

function isProcessExitStatement(statement: Node): boolean {
  return (
    ts.isExpressionStatement(statement) &&
    ts.isCallExpression(statement.expression) &&
    isProcessMember(statement.expression.expression, 'exit')
  );
}

// Shebangs and argument parsing mark a program run from a terminal, where printing is the
// point; DOM globals mark code that runs in a browser.
function hasNonServerBehaviour(sourceFile: SourceFile): boolean {
  if (sourceFile.text.startsWith('#!')) return true;
  let found = false;
  walkNodes(sourceFile, (node) => {
    if (!found && (isProcessMember(node, 'argv') || isBrowserGlobalUse(node))) found = true;
  });
  return found;
}

// A console call directly followed by `process.exit(...)`, or `console.error` followed by `throw`, reports why
// the program is stopping.
function isFailFastReport(node: Node, method: string): boolean {
  const statement = node.parent;
  if (!ts.isExpressionStatement(statement) || (!ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent))) {
    return false;
  }
  const siblings = statement.parent.statements;
  const next = siblings[siblings.indexOf(statement) + 1];
  if (!next) return false;
  return isProcessExitStatement(next) || (method === 'error' && ts.isThrowStatement(next));
}

function messageFor(method: string): string {
  const stream = STDERR_METHODS.has(method) ? 'stderr' : 'stdout';
  return `\`console.${method}\` in server code writes unstructured text to the process ${stream}, with no level, timestamp or request context, so production log tooling cannot filter or route it. Use the project's logger at the matching level, or remove the call if it was debugging output.`;
}

function valueBindingNames({ name, namedBindings }: ts.ImportClause): string[] {
  const names = name ? [name.text] : [];
  if (!namedBindings) return names;
  if (ts.isNamespaceImport(namedBindings)) return [...names, namedBindings.name.text];
  const valueElements = namedBindings.elements.filter((element) => !element.isTypeOnly);
  return [...names, ...valueElements.map((element) => element.name.text)];
}

function importedBindingNames(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || statement.importClause.isTypeOnly) continue;
    for (const name of valueBindingNames(statement.importClause)) names.add(name);
  }
  return names;
}

function moduleLevelNames(sourceFile: SourceFile): Set<string> {
  const names = importedBindingNames(sourceFile);
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
    }
  }
  return names;
}

function usesMethodOn(sourceFile: SourceFile, objectName: string, methods: ReadonlySet<string>): boolean {
  let found = false;
  walkNodes(sourceFile, (node) => {
    if (
      !found &&
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === objectName &&
      methods.has(node.name.text)
    ) {
      found = true;
    }
  });
  return found;
}

function plainLoggerName(sourceFile: SourceFile, mappedMethod: string): string | undefined {
  const names = moduleLevelNames(sourceFile);
  if (names.has('logger')) return 'logger';
  // `log` may be a plain function, so it only counts when the file already calls the same method on it.
  const hasLog = names.has('log') && usesMethodOn(sourceFile, 'log', new Set([mappedMethod]));
  return hasLog ? 'log' : undefined;
}

function isNestLoggerField(member: Node): boolean {
  return (
    ts.isPropertyDeclaration(member) &&
    ts.isIdentifier(member.name) &&
    member.name.text === 'logger' &&
    !hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
    member.initializer !== undefined &&
    ts.isNewExpression(member.initializer) &&
    ts.isIdentifier(member.initializer.expression) &&
    member.initializer.expression.text === 'Logger'
  );
}

function isStaticMethod(node: Node): boolean {
  return ts.isMethodDeclaration(node) && hasModifier(node, ts.SyntaxKind.StaticKeyword);
}

// A method or accessor of an object literal binds `this` to that object, not to a surrounding class.
function isObjectLiteralMember(node: Node): boolean {
  return (
    (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) &&
    ts.isObjectLiteralExpression(node.parent)
  );
}

// `this` only reaches the class from methods and arrow functions, not from nested `function`s, static
// members, static blocks or object-literal methods.
function enclosingNestClassHasLogger(callNode: Node): boolean {
  for (let current = callNode.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) return false;
    if (ts.isClassStaticBlockDeclaration(current)) return false;
    if (isStaticMethod(current) || isObjectLiteralMember(current)) return false;
    if (ts.isClassLike(current)) return current.members.some(isNestLoggerField);
  }
  return false;
}

interface LoggerReplacement {
  /** Source text that replaces `console.<method>`. */
  replacement: string;
}

/**
 * The logger call a console call can become, when the file already has a logger in scope. Trace, dir
 * and table have no equivalent level, so they never get one.
 */
function loggerReplacement(sourceFile: SourceFile, callNode: Node): LoggerReplacement | undefined {
  const method = consoleMethodOf(callNode);
  if (!method) return;
  const plainMethod = FIXABLE_METHODS[method];
  if (!plainMethod) return;
  if (enclosingNestClassHasLogger(callNode)) return { replacement: `this.logger.${NEST_METHODS[method]}` };
  const loggerName = plainLoggerName(sourceFile, plainMethod);
  return loggerName ? { replacement: `${loggerName}.${plainMethod}` } : undefined;
}

function isReportable(node: Node, sourceFile: SourceFile): boolean {
  return (
    !isInDevGuard(node, sourceFile) &&
    !isInsideLoggerImplementationOrBoundary(node) &&
    !(consoleMethodOf(node) === 'error' && isLastResortReport(node, sourceFile)) &&
    !isFailFastReport(node, consoleMethodOf(node) ?? '')
  );
}

function checkStrayConsole(sourceFile: SourceFile, file: string, options: CompilerOptions): Finding[] {
  const normalized = file.replaceAll('\\', '/');
  if (
    NON_PRODUCTION_PATH.test(normalized) ||
    FRONTEND_PATH.test(normalized) ||
    isVendoredOrSamplePath(normalized) ||
    isVendoredMinified(file) ||
    generatedSource(sourceFile, file)
  ) {
    return [];
  }
  if (!sourceFile.text.includes('console.') || isBundledLibrary(sourceFile)) return [];
  if (!isServerCode(sourceFile, options) || definesLogger(sourceFile, file)) return [];
  if (hasNonServerBehaviour(sourceFile)) return [];
  const isDisabled = eslintDisabledLines(sourceFile, NO_CONSOLE_RULES);
  const findings: Finding[] = [];
  walkNodes(sourceFile, (node) => {
    const method = consoleMethodOf(node);
    if (!method || !isReportable(node, sourceFile)) return;
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    if (isDisabled(position.line + 1)) return;
    findings.push({
      file,
      line: position.line + 1,
      column: position.character + 1,
      ruleId: 'stray-console',
      message: messageFor(method),
    });
  });
  return findings;
}

export { checkStrayConsole, consoleMethodOf, loggerReplacement };
