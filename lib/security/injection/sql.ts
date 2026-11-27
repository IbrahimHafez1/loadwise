// The SQL-text rules share one detector. The text argument is assembled here (a template, a `+`
// concatenation, or a local variable built from them) and some runtime part is neither a constant
// fragment (`analyzeFragment`), a number-like value, nor an identifier validated against an
// allowlist or closed regex; or the whole argument is request data. A part traced to the request
// makes the finding default. Assembled text with no traced part is
// contextual: it is usually an internal identifier or a placeholder list, and only a reader can
// tell.
import { ts } from '../../performance/compiler.js';
import { analyzeFragment } from '../../performance/pg-fragments.js';
import { operandsOf, isValidatedIdentifier } from '../pg-identifier-guards.js';
import { isPrunedType } from '../taint/sanitizers.js';
import { assignmentsTo } from '../taint/guards.js';
import { sourceSuffix, reportTraced, methodName, calledExport, createdBy } from './shared.js';
import type {
  BinaryExpression,
  CallExpression,
  Expression,
  Identifier,
  NewExpression,
  Node,
  PropertyDeclaration,
} from 'typescript';
import type { CheckerAdapter, LibraryCall, SecurityRuleContext, SymbolAdapter, Trace } from '../../shared/types.js';

const untracedReason =
  'No request value was traced into this SQL text; confirm every runtime part is a fixed or allowlisted fragment.';
const maxVariableDepth = 4;
// Private fields whose writes are being checked, so `this.x = this.x + 'a'` does not recurse
// forever.
const fieldsInProgress = new Set<SymbolAdapter>();

const prismaUnsafeMethods = new Set(['$queryRawUnsafe', '$executeRawUnsafe']);
const typeormBuilderMethods = new Set([
  'where',
  'andWhere',
  'orWhere',
  'having',
  'andHaving',
  'orHaving',
  'orderBy',
  'addOrderBy',
  'groupBy',
  'addGroupBy',
  'select',
  'addSelect',
]);
// Join methods take the joined relation first and the join condition third.
const typeormJoinMethods = new Set([
  'leftJoin',
  'leftJoinAndSelect',
  'innerJoin',
  'innerJoinAndSelect',
  'leftJoinAndMapOne',
  'leftJoinAndMapMany',
  'innerJoinAndMapOne',
  'innerJoinAndMapMany',
]);
const knexRawMethods = new Set(['whereRaw', 'havingRaw', 'orderByRaw', 'groupByRaw', 'joinRaw', 'fromRaw']);
const sequelizeModules = new Set(['sequelize', 'sequelize-typescript']);
const allSqlMethods = new Set([
  ...prismaUnsafeMethods,
  'raw',
  ...typeormBuilderMethods,
  ...typeormJoinMethods,
  ...knexRawMethods,
  'query',
  'execute',
  'literal',
]);

const messages: Record<string, (suffix: string) => string> = {
  'prisma-raw-unsafe-dynamic': (suffix) =>
    `This raw Prisma query builds SQL text from a runtime value${suffix}, which allows SQL injection. Use the tagged form \`$queryRaw\`...\${value}\`\` so values are bound, and choose identifiers from a fixed allowlist.`,
  'typeorm-dynamic-query-text': (suffix) =>
    `This TypeORM query builds SQL text from a runtime value${suffix}. Write \`:name\` in the text and pass \`{ name: value }\`; pick column names and sort directions from a fixed allowlist.`,
  'knex-raw-dynamic-text': (suffix) =>
    `This Knex raw fragment builds SQL text from a runtime value${suffix}. Use \`?\` for values and \`??\` for identifiers with a bindings array.`,
  'mysql-dynamic-query-text': (suffix) =>
    `This MySQL query builds SQL text from a runtime value${suffix}. Use \`?\` placeholders with a values array; choose identifiers from a fixed allowlist.`,
  'sequelize-dynamic-query-text': (suffix) =>
    `This Sequelize query builds SQL text from a runtime value${suffix}. Use \`replacements\` or \`bind\` instead of interpolation.`,
  'drizzle-sql-raw-dynamic': (suffix) =>
    `\`sql.raw\` inserts this runtime value${suffix} into the query unescaped. Use the \`sql\` template tag for values and \`sql.identifier()\` with an allowlist for names.`,
};

function hasModule(modules: ReadonlySet<string>, module: string | undefined) {
  return module !== undefined && modules.has(module);
}

function isAssembled(node: Node) {
  return (
    ts.isTemplateExpression(node) ||
    (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
  );
}

function isFixedPart(part: Expression, call: CallExpression, context: SecurityRuleContext): boolean {
  const { checker } = context;
  if (analyzeFragment(part, checker) !== undefined || isPrunedType(part, checker)) return true;
  if (isPlaceholderList(part, call, context) || isSequelizeEscape(part, context)) return true;
  if (ts.isIdentifier(part) && isLiteralLoopElement(part, checker)) return true;
  if (isFixedPrivateField(part, call, context)) return true;
  return ts.isIdentifier(part) && isValidatedIdentifier(part, call, checker);
}

// Fixed text, or text assembled only from fixed parts.
function isFixedText(value: Expression, call: CallExpression, context: SecurityRuleContext, depth: number) {
  return isFixedPart(value, call, context) || unresolvedParts(value, call, context, depth + 1)?.length === 0;
}

function isFixedPlaceholderCallback(
  callbackNode: Expression,
  call: CallExpression,
  context: SecurityRuleContext,
): boolean {
  const callback = ts.skipOuterExpressions(callbackNode);
  if (!(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || ts.isBlock(callback.body)) return false;
  const [element] = callback.parameters;
  if (element && !(ts.isIdentifier(element.name) && !isNameUsedIn(element.name, callback.body))) return false;
  if (isFixedPart(callback.body, call, context)) return true;
  // The second parameter is the element's index, a number even when the array is typed `any`.
  const index = callback.parameters[1];
  const isIndex = (part: Expression) =>
    !!index && ts.isIdentifier(part) && context.checker.getSymbolAtLocation(part)?.valueDeclaration === index;
  return unresolvedParts(callback.body, call, context, maxVariableDepth - 1)?.every(isIndex) ?? false;
}

// `ids.map(() => '?').join(', ')`, `Array(n).fill('?').join(', ')`,
// `Array.from({ length: n }, () => '?').join(', ')`, or `ids.map((_, i) => '$' + (i + 1))`:
// one placeholder per value, built without reading dynamic element values.
function isPlaceholderList(node: Expression, call: CallExpression, context: SecurityRuleContext) {
  let list = ts.skipOuterExpressions(node);
  if (ts.isCallExpression(list) && methodName(list) === 'join') {
    const [separator] = list.arguments;
    if (separator && !isFixedPart(separator, call, context)) return false;
    const joined = receiverOf(list);
    if (!joined) return false;
    list = ts.skipOuterExpressions(joined);
  }
  if (!ts.isCallExpression(list)) return false;
  const method = methodName(list);
  if (method === 'fill' && list.arguments.length >= 1) {
    return isFixedPart(list.arguments[0], call, context);
  }
  if (method === 'from' && list.arguments.length === 2) {
    const receiver = receiverOf(list);
    const root = receiver && ts.skipOuterExpressions(receiver);
    if (root && ts.isIdentifier(root) && root.text === 'Array') {
      return isFixedPlaceholderCallback(list.arguments[1], call, context);
    }
  }
  if (method !== 'map' || list.arguments.length !== 1) return false;
  return isFixedPlaceholderCallback(list.arguments[0], call, context);
}

// Any identifier with the same text counts as a use, shadowed or not, so the answer errs towards
// "used".
function isNameUsedIn(name: Identifier, body: Node) {
  return Boolean(
    (function visit(node: Node): boolean | undefined {
      return (ts.isIdentifier(node) && node.text === name.text) || ts.forEachChild(node, visit);
    })(body),
  );
}

// `sequelize.escape(value)` quotes the value as an SQL literal.
function isSequelizeEscape(node: Expression, context: SecurityRuleContext) {
  const escape = ts.skipOuterExpressions(node);
  return (
    ts.isCallExpression(escape) &&
    methodName(escape) === 'escape' &&
    isSequelizeInstance(receiverOf(escape), context.libraryCall(escape), context)
  );
}

// An array literal of string and number literals, or of tuples of them.
function isLiteralArray(node: Node | undefined): boolean {
  const array = node && ts.skipOuterExpressions(node);
  return (
    !!array &&
    ts.isArrayLiteralExpression(array) &&
    array.elements.every((element) => {
      const value = ts.skipOuterExpressions(element);
      return ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) || isLiteralArray(value);
    })
  );
}

// The array a `for...of` iterates: an array literal, a `const` bound to one, or a `readonly` field
// initialised with one.
function iteratedArray(expression: Expression, checker: CheckerAdapter): Expression | undefined {
  const iterated = ts.skipOuterExpressions(expression);
  if (ts.isArrayLiteralExpression(iterated)) return iterated;
  const isField = ts.isPropertyAccessExpression(iterated) && iterated.expression.kind === ts.SyntaxKind.ThisKeyword;
  if (!ts.isIdentifier(iterated) && !isField) return;
  const declaration = checker.getSymbolAtLocation(isField ? iterated.name : iterated)?.valueDeclaration;
  if (!declaration) return;
  if (ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const)
    return declaration.initializer;
  if (!ts.isPropertyDeclaration(declaration)) return;
  const readonly = declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword);
  return readonly ? declaration.initializer : undefined;
}

// `for (const table of ['a', 'b'])` and `for (const [table, policy] of POLICIES)`: each value is a
// literal.
function isLiteralLoopElement(identifier: Identifier, checker: CheckerAdapter) {
  let declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
  while (declaration && ts.isBindingElement(declaration)) declaration = declaration.parent.parent;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !(declaration.parent.flags & ts.NodeFlags.Const))
    return false;
  const loop = declaration.parent.parent;
  return ts.isForOfStatement(loop) && isLiteralArray(iteratedArray(loop.expression, checker));
}

// `this.table` for a private field whose initializer and every `=` or `+=` in its class are fixed
// text. Any other write (`++`, destructuring) leaves it unresolved.
function isFixedPrivateField(node: Expression, call: CallExpression, context: SecurityRuleContext) {
  const access = ts.skipOuterExpressions(node);
  if (!ts.isPropertyAccessExpression(access) || access.expression.kind !== ts.SyntaxKind.ThisKeyword) return false;
  const { checker } = context;
  const symbol = checker.getSymbolAtLocation(access.name);
  const declaration = symbol?.valueDeclaration;
  if (!declaration || !ts.isPropertyDeclaration(declaration)) return false;
  const isPrivate =
    ts.isPrivateIdentifier(declaration.name) ||
    declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword);
  if (!symbol || !isPrivate || fieldsInProgress.has(symbol)) return false;
  fieldsInProgress.add(symbol);
  try {
    return fieldValuesAreFixed(declaration, symbol, call, context);
  } finally {
    fieldsInProgress.delete(symbol);
  }
}

function fieldValuesAreFixed(
  declaration: PropertyDeclaration,
  symbol: SymbolAdapter,
  call: CallExpression,
  context: SecurityRuleContext,
) {
  const { checker } = context;
  const values: Expression[] = declaration.initializer ? [declaration.initializer] : [];
  let otherWrite = false;
  (function visit(child: Node): void {
    if (ts.isPropertyAccessExpression(child) && checker.getSymbolAtLocation(child.name) === symbol) {
      if (ts.isAssignmentTarget(child)) {
        const assignment = child.parent;
        if (ts.isBinaryExpression(assignment) && assignment.left === child && isPlainOrAppend(assignment))
          values.push(assignment.right);
        else otherWrite = true;
      }
    }
    ts.forEachChild(child, visit);
  })(declaration.parent);
  return !otherWrite && values.length > 0 && values.every((value) => isFixedText(value, call, context, 0));
}

function isPlainOrAppend(assignment: BinaryExpression) {
  const kind = assignment.operatorToken.kind;
  return kind === ts.SyntaxKind.EqualsToken || kind === ts.SyntaxKind.PlusEqualsToken;
}

// Every value a local variable can hold: its initializer and, for `let` and `var`, each `=` and
// `+=` in its scope.
function localValues(identifier: Identifier, checker: CheckerAdapter): Expression[] | undefined {
  const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return;
  const values: Expression[] = declaration.initializer ? [declaration.initializer] : [];
  if (declaration.parent.flags & ts.NodeFlags.Const) return values;
  const scope = ts.findAncestor(declaration, (node: Node) => ts.isFunctionLike(node) || ts.isSourceFile(node));
  if (!scope) return values;
  for (const assignment of assignmentsTo(declaration, scope, checker)) values.push(assignment.right);
  return values;
}

// The runtime parts of SQL text that are not provably fixed, or undefined when the text is not
// assembled here.
function unresolvedParts(
  node: Expression,
  call: CallExpression,
  context: SecurityRuleContext,
  depth = 0,
): Expression[] | undefined {
  const text = ts.skipOuterExpressions(node);
  if (isAssembled(text))
    return operandsOf(text).flatMap((part) =>
      isFixedPart(part, call, context) ? [] : (unresolvedParts(part, call, context, depth + 1) ?? [part]),
    );
  if (!ts.isIdentifier(text) || depth >= maxVariableDepth) return;
  const values = localValues(text, context.checker);
  // `let scope = 'SELECT ...'; scope += ' OR ...'`: every value the variable can hold is fixed.
  if (values?.length && values.every((value) => isFixedPart(value, call, context))) return [];
  if (!values?.some((value) => isAssembled(ts.skipOuterExpressions(value)))) return;
  if (isFixedPart(text, call, context)) return [];
  return values.flatMap((value) =>
    isFixedPart(value, call, context) ? [] : (unresolvedParts(value, call, context, depth + 1) ?? [value]),
  );
}

// { trace } when the SQL text argument is dynamic (trace undefined when no part reaches the
// request), else undefined.
function dynamicText(
  argument: Expression,
  call: CallExpression,
  context: SecurityRuleContext,
): { trace: Trace | undefined } | undefined {
  const parts = unresolvedParts(argument, call, context);
  if (parts === undefined) {
    const trace = context.taint.trace(argument, 'sql');
    return trace && { trace };
  }
  if (!parts.length) return;
  for (const part of parts) {
    const trace = context.taint.trace(part, 'sql');
    if (trace) return { trace };
  }
  return { trace: undefined };
}

function checkText(
  argument: Expression | undefined,
  call: CallExpression,
  ruleId: string,
  context: SecurityRuleContext,
) {
  if (!argument || ts.isSpreadElement(argument)) return;
  const dynamic = dynamicText(argument, call, context);
  if (!dynamic) return;
  const { trace } = dynamic;
  reportTraced(
    context,
    argument,
    ruleId,
    messages[ruleId](sourceSuffix(trace)),
    trace,
    trace ? undefined : untracedReason,
  );
}

function receiverOf(call: CallExpression): Expression | undefined {
  const callee = ts.skipOuterExpressions(call.expression);
  return ts.isPropertyAccessExpression(callee) ? callee.expression : undefined;
}

function prismaText(call: CallExpression, method: string): Expression | undefined {
  if (prismaUnsafeMethods.has(method)) return call.arguments[0];
  const receiverExpression = receiverOf(call);
  const receiver = receiverExpression && ts.skipOuterExpressions(receiverExpression);
  if (method === 'raw' && receiver && ts.isIdentifier(receiver) && receiver.text === 'Prisma') return call.arguments[0];
}

// Other ORMs (Strapi, MikroORM) also name a method `createQueryBuilder`: the call must resolve to
// TypeORM, or, when its receiver's type is unknown, the file must import TypeORM.
function isTypeormBuilderCall(call: CallExpression, context: SecurityRuleContext) {
  const library = context.libraryCall(call);
  if (library?.module) return library.module === 'typeorm';
  return call
    .getSourceFile()
    .statements.some(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === 'typeorm',
    );
}

// The builder comes from TypeORM's `createQueryBuilder(...)` in the same chain, or through a local
// `const qb = ...`.
function isQueryBuilderChain(expression: Expression, context: SecurityRuleContext, depth = 0): boolean {
  let node = ts.skipOuterExpressions(expression);
  while (node && (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node))) {
    if (ts.isCallExpression(node) && methodName(node) === 'createQueryBuilder')
      return isTypeormBuilderCall(node, context);
    node = ts.skipOuterExpressions(node.expression);
  }
  if (!node || !ts.isIdentifier(node) || depth >= maxVariableDepth) return false;
  const declaration = context.checker.getSymbolAtLocation(node)?.valueDeclaration;
  return (
    !!declaration &&
    ts.isVariableDeclaration(declaration) &&
    !!declaration.initializer &&
    isQueryBuilderChain(declaration.initializer, context, depth + 1)
  );
}

function typeormTexts(
  call: CallExpression,
  method: string,
  library: LibraryCall | undefined,
  context: SecurityRuleContext,
): (Expression | undefined)[] {
  if (method === 'query' && library?.module === 'typeorm') return [call.arguments[0]];
  const isBuilder = typeormBuilderMethods.has(method);
  if (!isBuilder && !typeormJoinMethods.has(method)) return [];
  const receiver = receiverOf(call);
  const fromBuilder =
    (library?.module === 'typeorm' && (library.exported ?? '').endsWith('QueryBuilder')) ||
    (receiver !== undefined && isQueryBuilderChain(receiver, context));
  if (!fromBuilder) return [];
  if (!isBuilder) return [call.arguments[0], call.arguments[2]];
  const [first] = call.arguments;
  const firstNode = first && ts.skipOuterExpressions(first);
  return firstNode && ts.isArrayLiteralExpression(firstNode) ? [...firstNode.elements] : [first];
}

function isKnexFactory(created: CallExpression | NewExpression, context: SecurityRuleContext) {
  return ts.isCallExpression(created) && context.libraryCall(created)?.module === 'knex';
}

function knexText(
  call: CallExpression,
  method: string,
  library: LibraryCall | undefined,
  context: SecurityRuleContext,
): Expression | undefined {
  if (knexRawMethods.has(method)) return call.arguments[0];
  if (method !== 'raw') return;
  const receiver = receiverOf(call);
  if (library?.module === 'knex' || createdBy(receiver, (created) => isKnexFactory(created, context), context.checker))
    return call.arguments[0];
}

function isMysqlModule(module: string | undefined) {
  return module === 'mysql' || module === 'mysql2' || !!module?.startsWith('mysql2/');
}

function mysqlText(
  call: CallExpression,
  method: string,
  library: LibraryCall | undefined,
  context: SecurityRuleContext,
): Expression | undefined {
  if (method !== 'query' && method !== 'execute') return;
  const recognised =
    isMysqlModule(library?.module) ||
    createdBy(
      receiverOf(call),
      (created) => ts.isCallExpression(created) && isMysqlModule(context.libraryCall(created)?.module),
      context.checker,
    );
  return recognised ? call.arguments[0] : undefined;
}

// `sequelize.query(...)`: the receiver is named `sequelize`, is typed or imported from Sequelize,
// or was created with `new Sequelize(...)`.
function isSequelizeInstance(
  receiver: Expression | undefined,
  library: LibraryCall | undefined,
  context: SecurityRuleContext,
): boolean {
  if (hasModule(sequelizeModules, library?.module)) return true;
  if (!receiver) return false;
  const node = ts.skipOuterExpressions(receiver);
  const name = ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
  if (name === 'sequelize') return true;
  return createdBy(
    node,
    (created) => ts.isNewExpression(created) && hasModule(sequelizeModules, context.libraryCall(created)?.module),
    context.checker,
  );
}

function sequelizeText(
  call: CallExpression,
  method: string,
  library: LibraryCall | undefined,
  context: SecurityRuleContext,
): Expression | undefined {
  if (method === 'query' && isSequelizeInstance(receiverOf(call), library, context)) return call.arguments[0];
  if (calledExport(library) === 'literal' && hasModule(sequelizeModules, library?.module)) return call.arguments[0];
  const receiverExpression = method === 'literal' ? receiverOf(call) : undefined;
  const receiver = receiverExpression && ts.skipOuterExpressions(receiverExpression);
  if (receiver && ts.isIdentifier(receiver) && /^[sS]equelize$/.test(receiver.text)) return call.arguments[0];
}

function drizzleText(call: CallExpression, method: string, library: LibraryCall | undefined): Expression | undefined {
  if (method === 'raw' && library?.exported === 'sql' && library.module?.startsWith('drizzle-orm'))
    return call.arguments[0];
}

function check(call: CallExpression, context: SecurityRuleContext) {
  if (!call.arguments.length) return;
  const method = methodName(call);
  if (method !== undefined && !allSqlMethods.has(method)) return;
  const library = context.libraryCall(call);
  const prisma = method && prismaText(call, method);
  if (prisma) return checkText(prisma, call, 'prisma-raw-unsafe-dynamic', context);
  if (!method && calledExport(library) === 'literal' && hasModule(sequelizeModules, library?.module))
    return checkText(call.arguments[0], call, 'sequelize-dynamic-query-text', context);
  if (!method) return;
  const drizzle = drizzleText(call, method, library);
  if (drizzle) return checkText(drizzle, call, 'drizzle-sql-raw-dynamic', context);
  const knex = knexText(call, method, library, context);
  if (knex) return checkText(knex, call, 'knex-raw-dynamic-text', context);
  const typeorm = typeormTexts(call, method, library, context);
  if (typeorm.length) {
    for (const text of typeorm) checkText(text, call, 'typeorm-dynamic-query-text', context);
    return;
  }
  const mysql = mysqlText(call, method, library, context);
  if (mysql) return checkText(mysql, call, 'mysql-dynamic-query-text', context);
  const sequelize = sequelizeText(call, method, library, context);
  if (sequelize) checkText(sequelize, call, 'sequelize-dynamic-query-text', context);
}

export { check };
