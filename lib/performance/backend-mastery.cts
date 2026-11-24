// Backend mastery rules, each decided from the receiver's package rather than from names:
// - sql-select-star-in-query
// - sequential-http-in-loop
// - check-then-update-race
// - payment-missing-idempotency-key
// - webhook-missing-idempotency-check
import { loadSyntax } from './compiler.cjs';
import { isTestSource } from './review-context.cjs';
import { enclosingRequestHandler } from './request-handlers.cjs';
import { findRepeatOwner } from './repeated.cjs';
import { describeCall, isDefaultAxios, isGlobalFetch } from './http-timeouts.cjs';
import { isSequentialByDesign, iteratesArrayLiteral, loopReviewReason } from './sequential-loops.cjs';
import { declaredInPackage } from './schema/ts-helpers.cjs';
import { importedFrom } from '../security/bindings.cjs';
import { calleeName, isFunctionWithBody } from './call-syntax.cjs';
import { createReferenceChecks } from './reference-checks.cjs';
import type {
  CallExpression,
  DoStatement,
  Expression,
  ForInStatement,
  ForOfStatement,
  ForStatement,
  Identifier,
  Node,
  PropertyAccessExpression,
  VariableDeclaration,
  WhileStatement,
} from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext } from '../shared/types.cjs';
import type { FunctionWithBody } from '../shared/types/function-summaries.cjs';
import type { RepeatOwner } from './types/repeat-owner.cjs';
const ts = loadSyntax();

type StatementLoop = ForStatement | ForOfStatement | ForInStatement | WhileStatement | DoStatement;

/**
 * The call a query chain starts at, with the proxy methods (`session`, `lean`, ...) the chain went
 * through.
 */
interface ChainBase {
  call: CallExpression;
  proxiedNames: string[];
}

const { mentionsIdentifier } = createReferenceChecks(ts);

const SQL_QUERY_PACKAGES = [
  'pg',
  '@types/pg',
  'pg-pool',
  '@types/pg-pool',
  'mysql2',
  'knex',
  '@prisma/client',
  '.prisma',
];
const SQL_QUERY_METHODS = new Set(['query', 'execute', 'raw', '$queryRawUnsafe']);
const SELECT_STAR_RE = /^\s*select\s+(?:\w+\.)?\*\s+from\s+(?!\(|information_schema\b|pg_)/i;
const SINGLE_ROW_RE = /\bwhere\b[\s\S]*\bid\s*=|\blimit\s+1\b/i;

const HTTP_MODULES = new Set(['got', 'ky', 'undici', 'node-fetch', 'axios']);
const HTTP_CLIENT_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'request', 'head']);
const AXIOS_TYPES = ['AxiosInstance', 'AxiosStatic'];
const JSX_FILE_RE = /\.[jt]sx$/i;

const READ_MODEL_PACKAGES = ['mongoose', 'sequelize'];
const READ_ONE_METHODS = new Set(['findById', 'findOne', 'findByPk']);
const WRITE_METHODS = new Set(['updateOne', 'update', 'findByIdAndUpdate', 'findOneAndUpdate']);
const TRANSACTION_CALLBACK_METHODS = new Set(['transaction', 'withTransaction']);
const TRANSACTION_OPTIONS = new Set(['session', 'transaction', 'lock']);
const QUERY_CHAIN_PROXIES = new Set(['session', 'lean', 'select', 'exec', 'populate']);
const COMPOUND_ARITHMETIC = new Set([ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken]);
const ARITHMETIC = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken]);

const STRIPE_PACKAGES = ['stripe'];
const STRIPE_MONEY_RESOURCES = new Set(['paymentIntents', 'charges', 'refunds', 'transfers', 'payouts']);

const ROUTER_PACKAGES = [
  'express',
  '@types/express',
  '@types/express-serve-static-core',
  'fastify',
  'hono',
  '@koa/router',
  'koa-router',
  '@types/koa-router',
  '@types/koa__router',
];
const DATABASE_PACKAGES = [...SQL_QUERY_PACKAGES, 'mongoose', 'sequelize', 'typeorm', 'drizzle-orm', 'mongodb'];
const WEBHOOK_PATH_RE = /webhook/i;
const INSERT_METHODS = new Set(['create', 'createMany', 'insert', 'insertOne', 'insertMany', 'bulkCreate']);
const DATABASE_READ_METHODS = new Set([
  'find',
  'findOne',
  'findUnique',
  'findFirst',
  'findById',
  'findByPk',
  'findMany',
  'findOneBy',
  'exists',
  'count',
  'select',
]);
const INSERT_SQL_RE = /^\s*insert\b/i;
const IDEMPOTENT_INSERT_SQL_RE = /\bon\s+(?:conflict|duplicate)\b|\binsert\s+ignore\b/i;
const SELECT_SQL_RE = /^\s*(?:select|with)\b/i;

function propertyAccessCallee(call: CallExpression): PropertyAccessExpression | undefined {
  const callee = ts.skipOuterExpressions(call.expression);
  return ts.isPropertyAccessExpression(callee) ? callee : undefined;
}

function staticSqlText(node: Node | undefined): string | undefined {
  if (!node) return;
  const expression = ts.skipOuterExpressions(node);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isTemplateExpression(expression)) return expression.head.text;
}

// ---- sql-select-star-in-query ----

function checkSelectStar(call: CallExpression, context: PerformanceRuleContext): void {
  const callee = propertyAccessCallee(call);
  if (!callee || !SQL_QUERY_METHODS.has(callee.name.text)) return;
  const sql = staticSqlText(call.arguments[0]);
  if (!sql || !SELECT_STAR_RE.test(sql)) return;
  if (!declaredInPackage(callee, context.checker, SQL_QUERY_PACKAGES)) return;
  context.report(
    call.arguments[0],
    'sql-select-star-in-query',
    'Raw SQL uses `SELECT *`, which transfers columns the code may not need, defeats covering-index scans, and exposes any column added later. List the columns you need.',
    SINGLE_ROW_RE.test(sql)
      ? 'A single-row lookup transfers little data; an explicit column list still keeps newly added sensitive columns out of the result.'
      : undefined,
  );
}

// ---- sequential-http-in-loop ----

function importedHttpModule(expression: Node, checker: CheckerAdapter): boolean {
  const module = importedFrom(expression, checker)?.module;
  return module !== undefined && HTTP_MODULES.has(module);
}

function isHttpRequest(call: CallExpression, context: PerformanceRuleContext): boolean {
  const described = describeCall(call);
  if (described?.library === 'fetch') return isGlobalFetch(described.receiver, context);
  if (described) return isDefaultAxios(described.receiver, context);
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isIdentifier(callee)) return importedHttpModule(callee, context.checker);
  if (!ts.isPropertyAccessExpression(callee) || !HTTP_CLIENT_METHODS.has(callee.name.text)) return false;
  return (
    context.isPackageType(callee.expression, ['axios'], AXIOS_TYPES) ||
    importedHttpModule(callee.expression, context.checker)
  );
}

// `await fetch(url)`, `(await fetch(url)).json()` and `await fetch(url).then(parse)` all wait for
// the request.
function isAwaitedRequest(call: CallExpression): boolean {
  let node: Node = call;
  for (;;) {
    const parent = node.parent;
    if (ts.isParenthesizedExpression(parent)) node = parent;
    else if (ts.isPropertyAccessExpression(parent) && parent.expression === node && ts.isCallExpression(parent.parent))
      node = parent.parent;
    else return ts.isAwaitExpression(parent);
  }
}

function isStatementLoop(node: Node): node is StatementLoop {
  return (
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

// A return or break after one response is a fallback chain: the next request only runs if this one
// fails.
function leavesLoopEarly(node: Node): boolean {
  if (ts.isFunctionLike(node)) return false;
  if (ts.isReturnStatement(node) || ts.isBreakStatement(node)) return true;
  return !!ts.forEachChild(node, (child) => leavesLoopEarly(child) || undefined);
}

function collectAssignedNames(node: Node, names: Set<string>): void {
  if (ts.isFunctionLike(node)) return;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
    ts.isIdentifier(node.left)
  )
    names.add(node.left.text);
  ts.forEachChild(node, (child) => collectAssignedNames(child, names));
}

// A variable the loop reassigns and the request reads (a cursor, a token) carries one iteration
// into the next.
function readsLoopCarriedValue(call: CallExpression, loop: StatementLoop): boolean {
  const assigned = new Set<string>();
  collectAssignedNames(loop.statement, assigned);
  return [...assigned].some((name) => call.arguments.some((argument) => mentionsIdentifier(argument, name)));
}

function isIndependentRequestLoop(call: CallExpression, loop: RepeatOwner | undefined): boolean {
  if (!loop || !isStatementLoop(loop)) return false;
  if (ts.isForOfStatement(loop) && loop.awaitModifier) return false;
  if (isSequentialByDesign(call, loop) || iteratesArrayLiteral(loop)) return false;
  return !leavesLoopEarly(loop.statement) && !readsLoopCarriedValue(call, loop);
}

function checkSequentialHttp(call: CallExpression, context: PerformanceRuleContext): void {
  if (JSX_FILE_RE.test(call.getSourceFile().fileName)) return;
  if (!isAwaitedRequest(call) || !isHttpRequest(call, context)) return;
  const loop = findRepeatOwner(call, context.checker);
  if (!isIndependentRequestLoop(call, loop)) return;
  context.report(
    call,
    'sequential-http-in-loop',
    'Awaiting an HTTP request inside a loop runs the requests one after another, so total latency grows with the number of items. Start independent requests together with `Promise.all`, or with a bounded pool such as `p-limit` when the list can be large or the API rate-limits.',
    loopReviewReason(call, loop, context.checker, 'sequential-http-in-loop'),
  );
}

// ---- check-then-update-race ----

function declarationOfIdentifier(identifier: Identifier, checker: CheckerAdapter): VariableDeclaration | undefined {
  const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
  return declaration && ts.isVariableDeclaration(declaration) ? declaration : undefined;
}

function chainBase(expression: Expression): ChainBase | undefined {
  let current = ts.skipOuterExpressions(expression);
  if (ts.isAwaitExpression(current)) current = ts.skipOuterExpressions(current.expression);
  const proxiedNames: string[] = [];
  while (ts.isCallExpression(current)) {
    const callee = ts.skipOuterExpressions(current.expression);
    if (!ts.isPropertyAccessExpression(callee)) return;
    const inner = ts.skipOuterExpressions(callee.expression);
    if (!(ts.isCallExpression(inner) && QUERY_CHAIN_PROXIES.has(callee.name.text))) break;
    proxiedNames.push(callee.name.text);
    current = inner;
  }
  return ts.isCallExpression(current) ? { call: current, proxiedNames } : undefined;
}

function hasTransactionOption(argument: Expression): boolean {
  const expression = argument && ts.skipOuterExpressions(argument);
  return (
    !!expression &&
    ts.isObjectLiteralExpression(expression) &&
    expression.properties.some(
      (property) =>
        ts.isSpreadAssignment(property) || (property.name && TRANSACTION_OPTIONS.has(property.name.getText())),
    )
  );
}

// `const account = await Account.findById(id)` on a Mongoose or Sequelize model, read outside any
// session or lock.
function isUnlockedModelRead(identifier: Identifier, checker: CheckerAdapter): boolean {
  const initializer = declarationOfIdentifier(identifier, checker)?.initializer;
  const chain = initializer && chainBase(initializer);
  const callee = chain && propertyAccessCallee(chain.call);
  if (!callee || !READ_ONE_METHODS.has(callee.name.text)) return false;
  if (chain.proxiedNames.includes('session') || chain.call.arguments.some(hasTransactionOption)) return false;
  return declaredInPackage(callee, checker, READ_MODEL_PACKAGES);
}

function isInsideTransactionCallback(node: Node): boolean {
  return !!ts.findAncestor(node, (ancestor) => {
    if (!ts.isCallExpression(ancestor)) return false;
    const name = calleeName(ancestor);
    return (
      name !== undefined &&
      TRANSACTION_CALLBACK_METHODS.has(name) &&
      ancestor.arguments.some((argument) => ts.isFunctionLike(ts.skipOuterExpressions(argument)))
    );
  });
}

// `account!.balance` and `account.balance` both read the field of the variable `account`.
function receiverOf(access: PropertyAccessExpression): Identifier | undefined {
  const receiver = ts.skipOuterExpressions(access.expression);
  return ts.isIdentifier(receiver) ? receiver : undefined;
}

function fieldOfReadModel(expression: Expression, checker: CheckerAdapter): PropertyAccessExpression | undefined {
  const access = ts.skipOuterExpressions(expression);
  if (!ts.isPropertyAccessExpression(access)) return;
  const receiver = receiverOf(access);
  return receiver && isUnlockedModelRead(receiver, checker) ? access : undefined;
}

function isNumberType(node: Node, checker: CheckerAdapter): boolean {
  return (checker.getTypeAtLocation(node).flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)) !== 0;
}

function sameField(left: PropertyAccessExpression, right: PropertyAccessExpression, checker: CheckerAdapter): boolean {
  const leftReceiver = receiverOf(left);
  const rightReceiver = receiverOf(right);
  if (!leftReceiver || !rightReceiver) return false;
  return (
    checker.getSymbolAtLocation(leftReceiver) === checker.getSymbolAtLocation(rightReceiver) &&
    left.name.text === right.name.text
  );
}

// `doc.balance - amount` or `amount + doc.balance`: arithmetic on the field that was read.
function arithmeticOn(expression: Expression, field: PropertyAccessExpression, checker: CheckerAdapter): boolean {
  const value = ts.skipOuterExpressions(expression);
  if (!ts.isBinaryExpression(value) || !ARITHMETIC.has(value.operatorToken.kind)) return false;
  return [value.left, value.right].some((operand) => {
    const access = ts.skipOuterExpressions(operand);
    return ts.isPropertyAccessExpression(access) && sameField(access, field, checker);
  });
}

function incrementedField(node: Node, checker: CheckerAdapter): PropertyAccessExpression | undefined {
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  )
    return fieldOfReadModel(node.operand, checker);
  if (!ts.isBinaryExpression(node)) return;
  const field = fieldOfReadModel(node.left, checker);
  if (!field) return;
  if (COMPOUND_ARITHMETIC.has(node.operatorToken.kind)) return field;
  const isAssignment = node.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  return isAssignment && arithmeticOn(node.right, field, checker) ? field : undefined;
}

function modifiesNumericFieldBefore(save: CallExpression, receiver: Identifier, checker: CheckerAdapter): boolean {
  const scope = ts.findAncestor(save, ts.isFunctionLike);
  if (!scope) return false;
  const receiverSymbol = checker.getSymbolAtLocation(receiver);
  return !!(function visit(node: Node): boolean | undefined {
    if (node.pos >= save.pos) return;
    const field = incrementedField(node, checker);
    const fieldReceiver = field && receiverOf(field);
    if (
      field &&
      fieldReceiver &&
      checker.getSymbolAtLocation(fieldReceiver) === receiverSymbol &&
      isNumberType(field, checker)
    )
      return true;
    return ts.forEachChild(node, visit);
  })(scope);
}

function checkSavedAfterNumericEdit(
  call: CallExpression,
  callee: PropertyAccessExpression,
  context: PerformanceRuleContext,
): boolean {
  if (callee.name.text !== 'save' || !ts.isIdentifier(callee.expression)) return false;
  if (!isUnlockedModelRead(callee.expression, context.checker)) return false;
  if (call.arguments.some(hasTransactionOption) || isInsideTransactionCallback(call)) return false;
  return modifiesNumericFieldBefore(call, callee.expression, context.checker);
}

// `Account.updateOne({ _id }, { balance: account.balance - amount })`: the new value is computed
// from the read.
function checkWriteFromReadValue(
  call: CallExpression,
  callee: PropertyAccessExpression,
  context: PerformanceRuleContext,
): boolean {
  if (!WRITE_METHODS.has(callee.name.text) || !declaredInPackage(callee, context.checker, READ_MODEL_PACKAGES))
    return false;
  if (call.arguments.some(hasTransactionOption) || isInsideTransactionCallback(call)) return false;
  return call.arguments.some((argument) => {
    const literal = ts.skipOuterExpressions(argument);
    return (
      ts.isObjectLiteralExpression(literal) &&
      literal.properties.some((property) => {
        if (!ts.isPropertyAssignment(property)) return false;
        const value = ts.skipOuterExpressions(property.initializer);
        if (!ts.isBinaryExpression(value) || !ARITHMETIC.has(value.operatorToken.kind)) return false;
        const field = fieldOfReadModel(value.left, context.checker) ?? fieldOfReadModel(value.right, context.checker);
        return !!field && isNumberType(field, context.checker);
      })
    );
  });
}

function checkCheckThenUpdateRace(call: CallExpression, context: PerformanceRuleContext): void {
  const callee = propertyAccessCallee(call);
  if (!callee) return;
  if (!checkSavedAfterNumericEdit(call, callee, context) && !checkWriteFromReadValue(call, callee, context)) return;
  context.report(
    call,
    'check-then-update-race',
    'A numeric field is read from the database, changed in JavaScript, and written back outside a transaction, so two concurrent requests can both start from the same value and one update is lost. Use an atomic update (`$inc`, `increment`, `UPDATE ... SET col = col - $1 WHERE col >= $1`) or lock the row inside a transaction.',
    enclosingRequestHandler(call)
      ? undefined
      : 'Not inside a request handler, so concurrent writers may not exist; confirm before changing.',
  );
}

// ---- payment-missing-idempotency-key ----

function hasIdempotencyKey(optionsArgument: Expression): boolean {
  const options = ts.skipOuterExpressions(optionsArgument);
  // Anything but a literal (a variable, a spread) may already carry the key.
  if (!ts.isObjectLiteralExpression(options)) return true;
  return options.properties.some(
    (property) => ts.isSpreadAssignment(property) || property.name?.getText() === 'idempotencyKey',
  );
}

function checkPaymentIdempotency(call: CallExpression, context: PerformanceRuleContext): void {
  const callee = propertyAccessCallee(call);
  if (!callee || callee.name.text !== 'create') return;
  const resource = ts.skipOuterExpressions(callee.expression);
  if (!ts.isPropertyAccessExpression(resource) || !STRIPE_MONEY_RESOURCES.has(resource.name.text)) return;
  if (!declaredInPackage(callee, context.checker, STRIPE_PACKAGES)) return;
  if (call.arguments[1] && hasIdempotencyKey(call.arguments[1])) return;
  context.report(
    call,
    'payment-missing-idempotency-key',
    `\`${resource.name.text}.create()\` moves money without an \`idempotencyKey\` option, so a retried request after a timeout can charge, refund or pay out twice. Pass \`{ idempotencyKey }\` derived from a stable order or attempt id.`,
  );
}

// ---- webhook-missing-idempotency-check ----

function isDatabaseCall(callee: PropertyAccessExpression, context: PerformanceRuleContext): boolean {
  return declaredInPackage(callee, context.checker, DATABASE_PACKAGES);
}

function isInsertWithoutConflictHandling(
  call: CallExpression,
  callee: PropertyAccessExpression,
  context: PerformanceRuleContext,
): boolean {
  if (!isDatabaseCall(callee, context)) return false;
  if (INSERT_METHODS.has(callee.name.text)) return true;
  if (!SQL_QUERY_METHODS.has(callee.name.text)) return false;
  const sql = staticSqlText(call.arguments[0]);
  return !!sql && INSERT_SQL_RE.test(sql) && !IDEMPOTENT_INSERT_SQL_RE.test(sql);
}

function isDatabaseRead(
  call: CallExpression,
  callee: PropertyAccessExpression,
  context: PerformanceRuleContext,
): boolean {
  if (!isDatabaseCall(callee, context)) return false;
  if (DATABASE_READ_METHODS.has(callee.name.text)) return true;
  const sql = SQL_QUERY_METHODS.has(callee.name.text) ? staticSqlText(call.arguments[0]) : undefined;
  return !!sql && SELECT_SQL_RE.test(sql);
}

// The first insert the handler runs that no earlier database read could have guarded.
function unguardedInsert(handler: FunctionWithBody, context: PerformanceRuleContext): CallExpression | undefined {
  let readSeen = false;
  let unguarded: CallExpression | undefined;
  (function visit(node: Node): void {
    if (unguarded) return;
    if (ts.isCallExpression(node)) {
      const callee = propertyAccessCallee(node);
      if (callee && isDatabaseRead(node, callee, context)) readSeen = true;
      else if (callee && !readSeen && isInsertWithoutConflictHandling(node, callee, context)) unguarded = node;
    }
    ts.forEachChild(node, visit);
  })(handler.body);
  return unguarded;
}

function webhookHandler(call: CallExpression): FunctionWithBody | undefined {
  const handler =
    call.arguments.length > 1 ? ts.skipOuterExpressions(call.arguments[call.arguments.length - 1]) : undefined;
  return isFunctionWithBody(handler) ? handler : undefined;
}

function checkWebhookIdempotency(call: CallExpression, context: PerformanceRuleContext): void {
  const callee = propertyAccessCallee(call);
  if (!callee || callee.name.text !== 'post') return;
  const route = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  if (!route || !ts.isStringLiteralLike(route) || !WEBHOOK_PATH_RE.test(route.text)) return;
  if (!declaredInPackage(callee, context.checker, ROUTER_PACKAGES)) return;
  const handler = webhookHandler(call);
  const insert = handler && unguardedInsert(handler, context);
  if (!insert) return;
  context.report(
    insert,
    'webhook-missing-idempotency-check',
    `Webhook route \`${route.text}\` inserts a row without first checking whether the event was already handled. Providers deliver webhooks at least once, so a redelivery creates a duplicate. Store the event id under a unique constraint (or insert with a conflict clause) before applying the effect.`,
    'The check may live in middleware or the insert may be keyed by the event id through a unique index; confirm before changing.',
  );
}

function checkBackendMasteryCall(call: CallExpression, context: PerformanceRuleContext): void {
  if (isTestSource(call.getSourceFile().fileName)) return;
  checkSelectStar(call, context);
  checkSequentialHttp(call, context);
  checkCheckThenUpdateRace(call, context);
  checkPaymentIdempotency(call, context);
  checkWebhookIdempotency(call, context);
}

export { checkBackendMasteryCall as check };
