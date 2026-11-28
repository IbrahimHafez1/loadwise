import {
  hasMultilineTemplate,
  ts,
  textOf,
  ancestor,
  calleeCall,
  indentationAt,
  lineStart,
  freshName,
  isPlainReference,
  mentionsIdentifier,
  requireReview,
} from './helpers.js';
import { drizzleScopeUnverified, drizzleUnfilteredWrite } from './integrity-drizzle.js';
import { eolOf, formatterNote, unitFor, wrapStatements } from './integrity-wrap.js';
import type {
  BindingName,
  Block,
  CallExpression,
  ElementAccessExpression,
  ExpressionStatement,
  Identifier,
  ImportDeclaration,
  Node,
  ObjectLiteralExpression,
  PropertyAccessExpression,
  PropertyAssignment,
  SignatureDeclaration,
  ShorthandPropertyAssignment,
  SourceFile,
  Statement,
  SyntaxKind,
  VariableDeclaration,
  VariableStatement,
} from 'typescript';
import type { FixResult, SiteFixInput, TextEdit } from '../../shared/types.js';

// The offsets of whole lines to delete.
interface LineRange {
  start: number;
  end: number;
}

type ScopedProperty = PropertyAssignment | ShorthandPropertyAssignment;

const transactionStart = /^\s*(?:begin|start\s+transaction)\b/i;
const transactionEnd = /^\s*(?:commit|rollback|end|abort)\b/i;
const transactionControl = /^\s*(?:begin|start|commit|rollback|end|abort|savepoint|release|set\s+transaction)\b/i;

// ---- pg-unreleased-checkout ----

function unreleasedCheckout({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const connect = calleeCall(node);
  if (!connect || !ts.isPropertyAccessExpression(connect.expression) || connect.expression.name.text !== 'connect')
    return;
  const pool = connect.expression.expression;
  if (!isPlainReference(pool)) return;
  let receiver: Node = connect;
  while (
    ts.isParenthesizedExpression(receiver.parent) ||
    ts.isAwaitExpression(receiver.parent) ||
    ts.isNonNullExpression(receiver.parent)
  )
    receiver = receiver.parent;
  const access = receiver.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== receiver || access.name.text !== 'query') return;
  const query = access.parent;
  if (!ts.isCallExpression(query) || query.expression !== access) return;
  // A transaction command on a client nobody keeps has no meaningful pool.query() equivalent.
  const [statement] = query.arguments;
  if (statement && ts.isStringLiteralLike(statement) && transactionControl.test(statement.text)) return;
  return {
    edits: [{ start: receiver.getStart(), end: receiver.end, text: textOf(pool) }],
    note: '`pool.query()` checks out a connection for this one statement and releases it afterwards.',
  };
}

// ---- pg-transaction-on-pool ----

function queryText(call: CallExpression): string | undefined {
  const [argument] = call.arguments;
  if (!argument) return;
  if (ts.isStringLiteralLike(argument)) return argument.text;
  if (!ts.isObjectLiteralExpression(argument)) return;
  const property = argument.properties.find(
    (candidate): candidate is PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && candidate.name.getText() === 'text',
  );
  return property && ts.isStringLiteralLike(property.initializer) ? property.initializer.text : undefined;
}

function isQueryAccess(access: Node): access is PropertyAccessExpression | ElementAccessExpression {
  if (ts.isPropertyAccessExpression(access)) return access.name.text === 'query';
  return (
    ts.isElementAccessExpression(access) &&
    ts.isStringLiteralLike(access.argumentExpression) &&
    access.argumentExpression.text === 'query'
  );
}

// Every expression in `root` spelled like `poolText`, except member names such as the `pool` in
// `this.pool`.
function referencesTo(root: Node, poolText: string): Node[] {
  const found: Node[] = [];
  (function visit(child: Node): void {
    const candidate =
      ts.isIdentifier(child) || ts.isPropertyAccessExpression(child) || child.kind === ts.SyntaxKind.ThisKeyword;
    const isMemberName = ts.isPropertyAccessExpression(child.parent) && child.parent.name === child;
    if (candidate && !isMemberName && textOf(child) === poolText) {
      found.push(child);
      return;
    }
    ts.forEachChild(child, visit);
  })(root);
  return found;
}

function declaredNames(statement: Statement): string[] {
  if (!ts.isVariableStatement(statement)) return [];
  const names: string[] = [];
  for (const declaration of statement.declarationList.declarations) collectNames(declaration.name, names);
  return names;
}

function collectNames(name: BindingName, names: string[]): void {
  if (ts.isIdentifier(name)) names.push(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) collectNames(element.name, names);
}

// The function around a pool query and the block that holds its statements.
interface PoolUsage {
  poolText: string;
  access: Node;
  body: Block;
  owner: SignatureDeclaration;
  receivers: Node[];
  queries: CallExpression[];
}

// The statements that the BEGIN-through-COMMIT wrapping covers, with the pool uses inside them.
interface TransactionRegion {
  statements: Statement[];
  start: number;
  receivers: Node[];
  queries: CallExpression[];
}

interface TransactionRange {
  first: number;
  last: number;
  begin: CallExpression;
}

function poolQueryCalls(receivers: readonly Node[]): CallExpression[] {
  return receivers.flatMap((receiver) => {
    const parent = receiver.parent;
    return isQueryAccess(parent) && ts.isCallExpression(parent.parent) && parent.parent.expression === parent
      ? [parent.parent]
      : [];
  });
}

function poolAccessOf(node: Node): PropertyAccessExpression | ElementAccessExpression | undefined {
  const access = node.parent;
  if (!access || !isQueryAccess(access) || !isPlainReference(access.expression)) return;
  return access;
}

function poolUsageOf(access: PropertyAccessExpression | ElementAccessExpression): PoolUsage | undefined {
  const poolText = textOf(access.expression);
  const owner = ancestor(access, ts.isFunctionLike);
  const body = owner && 'body' in owner ? owner.body : undefined;
  if (!owner || !body || !ts.isBlock(body)) return;
  const receivers = referencesTo(body, poolText);
  return { poolText, access, body, owner, receivers, queries: poolQueryCalls(receivers) };
}

function topLevelIndex(body: Block, inner: Node): number {
  const top = ancestor(inner, (current) => current.parent === body);
  return top ? body.statements.findIndex((statement) => statement === top) : -1;
}

// The first and last top-level statements between the BEGIN and the last COMMIT, when the finding
// sits inside them.
function transactionRange({ body, access, queries }: PoolUsage): TransactionRange | undefined {
  const begin = queries.find((call) => transactionStart.test(queryText(call) ?? ''));
  const ends = queries.filter((call) => transactionEnd.test(queryText(call) ?? ''));
  if (!begin || !ends.length) return;
  const first = topLevelIndex(body, begin);
  const last = topLevelIndex(body, ends[ends.length - 1]);
  const findingIndex = topLevelIndex(body, access);
  if (first < 0 || findingIndex < first || findingIndex > last) return;
  return { first, last, begin };
}

// Wrapping the range in try would hide its declarations from the statements after it.
function declarationsUsedLater(region: readonly Statement[], later: readonly Statement[]): boolean {
  return region.some((statement) =>
    declaredNames(statement).some((name) => later.some((next) => mentionsIdentifier(next, name))),
  );
}

function transactionRegion(usage: PoolUsage, sourceFile: SourceFile): TransactionRegion | undefined {
  const { body, owner, receivers, queries } = usage;
  const range = transactionRange(usage);
  if (!range) return;
  const statements = body.statements.slice(range.first, range.last + 1);
  const start = statements[0].getStart(sourceFile);
  const regionEnd = statements[statements.length - 1].end;
  const inRegion = (child: Node): boolean => child.getStart(sourceFile) >= start && child.end <= regionEnd;
  // Passing the pool to a helper or checking out from it inside the range would still bypass the
  // client.
  const regionReceivers = receivers.filter(inRegion);
  const regionQueries = queries.filter(inRegion);
  if (regionReceivers.length !== regionQueries.length || regionQueries[0] !== range.begin) return;
  // `finally` releases the client as soon as the block exits, so every query must have settled by
  // then.
  const settled = (call: CallExpression) =>
    ts.isAwaitExpression(call.parent) && ancestor(call, ts.isFunctionLike) === owner;
  if (!regionQueries.every(settled)) return;
  if (declarationsUsedLater(statements, body.statements.slice(range.last + 1))) return;
  return { statements, start, receivers: regionReceivers, queries: regionQueries };
}

function transactionFooter(client: string, unit: string, rollsBack: boolean): string[] {
  return [
    ...(rollsBack ? [] : ['} catch (error) {', `${unit}await ${client}.query('ROLLBACK');`, `${unit}throw error;`]),
    '} finally {',
    `${unit}${client}.release();`,
    '}',
  ];
}

function wrapPoolTransaction(
  region: TransactionRegion,
  poolText: string,
  client: string,
  sourceFile: SourceFile,
  text: string,
): FixResult | undefined {
  const unit = unitFor(indentationAt(text, region.start));
  const rollsBack = region.queries.some((call) => /^\s*(?:rollback|abort)\b/i.test(queryText(call) ?? ''));
  const wrapped = wrapStatements({
    text,
    sourceFile,
    first: region.statements[0],
    last: region.statements[region.statements.length - 1],
    header: [`const ${client} = await ${poolText}.connect();`, 'try {'],
    footer: transactionFooter(client, unit, rollsBack),
    replacements: region.receivers.map((receiver) => ({
      start: receiver.getStart(sourceFile),
      end: receiver.end,
      text: client,
    })),
  });
  if (!wrapped) return;
  return {
    edits: wrapped.edits,
    note:
      `BEGIN through COMMIT now run on one checked-out connection, released in \`finally\`.` +
      (rollsBack ? '' : ' A failure now rolls back before the connection returns to the pool.') +
      (wrapped.reindented ? '' : formatterNote),
  };
}

function transactionOnPool({ node, sourceFile, text }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile || text === undefined) return;
  const access = poolAccessOf(node);
  if (!access) return;
  const usage = poolUsageOf(access);
  if (!usage) return;
  const region = transactionRegion(usage, sourceFile);
  if (!region) return;
  const client = freshName(sourceFile, 'client');
  if (!client) return;
  return wrapPoolTransaction(region, usage.poolText, client, sourceFile, text);
}

// ---- pool-created-per-request-or-item ----

const closingMethods = new Set(['end', 'close', 'quit', 'disconnect', '$disconnect', 'destroy']);
const declarationKinds = new Set<SyntaxKind>([
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.EnumDeclaration,
]);

function bindingNamesWithin(root: Node): Set<string> {
  const names = new Set<string>();
  (function visit(child: Node): void {
    const { parent } = child;
    if (ts.isIdentifier(child) && declarationKinds.has(parent.kind) && 'name' in parent && parent.name === child)
      names.add(child.text);
    ts.forEachChild(child, visit);
  })(root);
  return names;
}

function isReference(identifier: Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === identifier) return false;
  return true;
}

function topLevelDeclaration(sourceFile: SourceFile, name: string): Statement | undefined {
  return sourceFile.statements.find((statement) => {
    if (ts.isVariableStatement(statement))
      return statement.declarationList.declarations.some((declaration) => bindingNamesWithin(declaration).has(name));
    if (ts.isImportDeclaration(statement))
      return bindingNamesWithin(statement).has(name) || importsName(statement, name);
    return ts.isDeclarationStatement(statement) && statement.name?.text === name;
  });
}

function importsName(statement: ImportDeclaration, name: string): boolean {
  const clause = statement.importClause;
  if (!clause) return false;
  if (clause.name?.text === name) return true;
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return bindings.name.text === name;
  return bindings.elements.some((element) => element.name.text === name);
}

// True when every name the constructor reads already exists, with its final value, at module scope
// above `topLevel`.
function readableAtModuleScope(creation: Node, topLevel: Node, sourceFile: SourceFile): boolean {
  const local = bindingNamesWithin(topLevel);
  let readable = true;
  (function visit(child: Node): void {
    if (!readable) return;
    if (child.kind === ts.SyntaxKind.ThisKeyword || child.kind === ts.SyntaxKind.SuperKeyword) readable = false;
    else if (ts.isIdentifier(child) && isReference(child)) {
      const declaration = topLevelDeclaration(sourceFile, child.text);
      const hoisted =
        declaration &&
        (ts.isImportDeclaration(declaration) ||
          ts.isFunctionDeclaration(declaration) ||
          (ts.isVariableStatement(declaration) && !(declaration.declarationList.flags & ts.NodeFlags.BlockScoped)));
      if (local.has(child.text) || (declaration && !hoisted && declaration.pos >= topLevel.pos)) readable = false;
    }
    ts.forEachChild(child, visit);
  })(creation);
  return readable;
}

// The whole lines holding `statement` with the line break before them, when nothing else shares
// those lines. Taking the preceding break keeps the removal inside the hunk that shows it.
function wholeLines(text: string, statement: Node): LineRange | undefined {
  const start = lineStart(text, statement.getStart());
  const lineBreak = text.indexOf('\n', statement.end);
  let end = lineBreak === -1 ? text.length : lineBreak;
  if (text[end - 1] === '\r') end--;
  if (!start || text.slice(start, statement.getStart()).trim() || text.slice(statement.end, end).trim()) return;
  return { start: start - (text[start - 2] === '\r' ? 2 : 1), end };
}

function redeclaresName(node: Node, name: string): boolean {
  const opensScope =
    ts.isFunctionLike(node) || ts.isBlock(node) || ts.isCatchClause(node) || ts.isIterationStatement(node, false);
  return opensScope && bindingNamesWithin(node).has(name);
}

function closingStatements(scope: Node, name: string): ExpressionStatement[] | undefined {
  const statements: ExpressionStatement[] = [];
  let usable = true;
  (function visit(child: Node): void {
    if (!usable) return;
    // A nested scope that redeclares the name closes a different resource, so no fix is offered.
    if (child !== scope && redeclaresName(child, name)) {
      usable = false;
      return;
    }
    if (ts.isIdentifier(child) && child.text === name && isReference(child)) {
      const access = child.parent;
      const call = access.parent;
      if (
        ts.isPropertyAccessExpression(access) &&
        closingMethods.has(access.name.text) &&
        ts.isCallExpression(call) &&
        call.expression === access
      ) {
        let holder: Node = call.parent;
        if (ts.isAwaitExpression(holder)) holder = holder.parent;
        if (ts.isExpressionStatement(holder) && ts.isBlock(holder.parent)) statements.push(holder);
        else usable = false;
      }
    }
    ts.forEachChild(child, visit);
  })(scope);
  return usable ? statements : undefined;
}

function connects(scope: Node, name: string): boolean {
  let found = false;
  (function visit(child: Node): void {
    if (found) return;
    if (
      ts.isPropertyAccessExpression(child) &&
      child.name.text === 'connect' &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === name
    )
      found = true;
    else ts.forEachChild(child, visit);
  })(scope);
  return found;
}

// The `const pool = new Pool()` statement a per-request pool fix would hoist.
interface PoolCreation {
  creation: Node;
  statement: VariableStatement;
  scope: Block;
  name: string;
}

// The `new X()` or `X()` call that initializes a single plain `const` name.
function declaredCreation(node: Node): { creation: Node; declaration: VariableDeclaration; name: string } | undefined {
  const creation = ts.isNewExpression(node) ? node : calleeCall(node);
  if (!creation) return;
  const declaration = creation.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== creation) return;
  if (!ts.isIdentifier(declaration.name)) return;
  return { creation, declaration, name: declaration.name.text };
}

// The sole-declaration, non-exported `const` statement inside a block.
function soleConstStatement(
  declaration: VariableDeclaration,
): { statement: VariableStatement; scope: Block } | undefined {
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list)) return;
  const statement = list.parent;
  if (!(list.flags & ts.NodeFlags.Const) || list.declarations.length !== 1 || !ts.isVariableStatement(statement))
    return;
  const scope = statement.parent;
  if (!ts.isBlock(scope) || statement.modifiers?.length) return;
  return { statement, scope };
}

function poolCreationOf(node: Node): PoolCreation | undefined {
  const declared = declaredCreation(node);
  if (!declared) return;
  const placement = soleConstStatement(declared.declaration);
  if (!placement) return;
  return { creation: declared.creation, name: declared.name, ...placement };
}

// The top-level statement holding the creation when its constructor can run at module scope.
function moduleScopeAnchor(found: PoolCreation, sourceFile: SourceFile): Node | undefined {
  const { creation, statement, name } = found;
  const topLevel = ancestor(statement, (current) => current.parent && ts.isSourceFile(current.parent));
  if (!topLevel || topLevelDeclaration(sourceFile, name)) return;
  if (!readableAtModuleScope(creation, topLevel, sourceFile)) return;
  if (hasMultilineTemplate(sourceFile, statement.getStart(), statement.end)) return;
  return topLevel;
}

// A shared Redis or Mongo client cannot be connected again on each call.
function reconnectsSharedClient(message: string, scope: Node, name: string): boolean {
  return /^(?:redis|@redis\/client|mongodb)\./.test(message) && connects(scope, name);
}

// The whole-line removals for the statements, or undefined when any of them shares its lines.
function removalsFor(text: string, statements: readonly Node[]): LineRange[] | undefined {
  const removals: LineRange[] = [];
  for (const removed of statements) {
    const removal = wholeLines(text, removed);
    if (!removal) return;
    removals.push(removal);
  }
  return removals;
}

function poolNote(closingCount: number): string {
  return (
    'Created once when the module loads and shared by every call, so its configuration must be available at import time.' +
    (closingCount ? ' The per-call close was removed; close it once at shutdown instead.' : ' Close it at shutdown.')
  );
}

function poolPerRequest({ finding, node, sourceFile, text }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile || text === undefined) return;
  const found = poolCreationOf(node);
  if (!found) return;
  const { statement, scope, name } = found;
  const topLevel = moduleScopeAnchor(found, sourceFile);
  if (!topLevel) return;
  if (reconnectsSharedClient(finding.message, scope, name)) return;
  const closing = closingStatements(scope, name);
  if (!closing) return;
  const removals = removalsFor(text, [statement, ...closing]);
  if (!removals) return;

  const eol = eolOf(text);
  const indentation = indentationAt(text, statement.getStart());
  const hoisted = textOf(statement)
    .split(/\r?\n/)
    .map((line) => (line.startsWith(indentation) ? line.slice(indentation.length) : line))
    .join(eol);
  const comments = ts.getLeadingCommentRanges(text, topLevel.pos) ?? [];
  const insertAt = lineStart(text, comments[0]?.pos ?? topLevel.getStart());
  return {
    edits: [
      { start: insertAt, end: insertAt, text: hoisted + eol + eol },
      ...removals.map((removal) => ({ ...removal, text: '' })),
    ],
    note: poolNote(closing.length),
  };
}

// ---- prisma-transaction-client-escape ----

function transactionClientEscape({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const method = node.parent;
  if (!ts.isPropertyAccessExpression(method) || method.name !== node) return;
  const delegate = method.expression;
  if (!ts.isPropertyAccessExpression(delegate)) return;
  const client = delegate.expression;
  const callback = ancestor(method, ts.isFunctionLike);
  if (!callback) return;
  let argument: Node = callback;
  while (ts.isParenthesizedExpression(argument.parent)) argument = argument.parent;
  const transaction = argument.parent;
  if (
    !ts.isCallExpression(transaction) ||
    transaction.arguments[0] !== argument ||
    !ts.isPropertyAccessExpression(transaction.expression) ||
    transaction.expression.name.text !== '$transaction' ||
    textOf(transaction.expression.expression) !== textOf(client)
  )
    return;
  const [parameter] = callback.parameters;
  const edits: TextEdit[] = [];
  let name: string;
  if (parameter) {
    if (!ts.isIdentifier(parameter.name)) return;
    name = parameter.name.text;
    // A nested binding with the same name could make the replacement read something else.
    const callbackBody = 'body' in callback ? callback.body : undefined;
    if (callbackBody && bindingNamesWithin(callbackBody).has(name)) return;
  } else {
    // Without parameters both arrow and function callbacks have parentheses to receive the new one.
    const fresh = freshName(sourceFile, 'tx');
    if (!fresh) return;
    name = fresh;
    edits.push({ start: callback.parameters.pos, end: callback.parameters.pos, text: name });
  }
  edits.push({ start: client.getStart(sourceFile), end: client.end, text: name });
  return {
    edits,
    note: 'The call now runs inside the transaction and rolls back with it. If it must persist when the transaction fails (an audit or failure record), move it after the transaction instead.',
  };
}

// ---- prisma-scope-unverified ----

const uniqueOperations = new Set(['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert']);

// Spreads and computed keys can override any property this fix adds.
function plainObject(node: Node): node is ObjectLiteralExpression {
  return (
    ts.isObjectLiteralExpression(node) &&
    node.properties.every(
      (property) =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        !ts.isComputedPropertyName(property.name),
    )
  );
}

function propertyNamed(object: ObjectLiteralExpression, name: string): ScopedProperty | undefined {
  return object.properties.find(
    (property): property is ScopedProperty =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      !ts.isComputedPropertyName(property.name) &&
      property.name.text === name,
  );
}

// Adds `property` as the first entry of an object literal, following its single- or multi-line
// layout.
function addFirstProperty(object: ObjectLiteralExpression, property: string, text: string): TextEdit {
  const [first] = object.properties;
  if (!first) return { start: object.getStart(), end: object.end, text: `{ ${property} }` };
  const firstStart = first.getStart();
  const multiline = text.slice(object.getStart(), firstStart).includes('\n');
  const separator = multiline ? ',' + eolOf(text) + indentationAt(text, firstStart) : ', ';
  return { start: firstStart, end: firstStart, text: property + separator };
}

function prismaScopeUnverified({ finding, node, text }: SiteFixInput): FixResult | undefined {
  if (!node || text === undefined) return;
  const field = /Constrain where\.([A-Za-z_][A-Za-z0-9_]*) to/.exec(finding.message)?.[1];
  const access = node.parent;
  const call = access.parent;
  if (!field || !ts.isCallExpression(call) || call.expression !== access || call.arguments.length !== 1) return;
  const options = call.arguments[0];
  if (!plainObject(options) || finding.verifiedScopeField !== field) return;
  const where = propertyNamed(options, 'where');
  const operation = ts.isPropertyAccessExpression(access)
    ? access.name.text
    : ts.isElementAccessExpression(access) && ts.isStringLiteralLike(access.argumentExpression)
      ? access.argumentExpression.text
      : undefined;
  let edit: TextEdit;
  if (!where) edit = addFirstProperty(options, `where: { ${field} }`, text);
  else if (ts.isPropertyAssignment(where) && ts.isObjectLiteralExpression(where.initializer)) {
    if (!plainObject(where.initializer)) return;
    // An existing filter on the field would conflict; which value is right is a human decision.
    if (propertyNamed(where.initializer, field)) return;
    edit = addFirstProperty(where.initializer, field, text);
  } else {
    // Unique lookups need their unique key at the top level, which AND would hide.
    if (operation !== undefined && uniqueOperations.has(operation)) return;
    const condition = ts.isShorthandPropertyAssignment(where) ? 'where' : textOf(where.initializer);
    edit = { start: where.getStart(), end: where.end, text: `where: { AND: [${condition}, { ${field} }] }` };
  }
  return {
    edits: [edit],
    note: `Filters by the \`${field}\` declared above. The checker verified its value comes from the configured authorization function.`,
  };
}

export default {
  'pg-unreleased-checkout': unreleasedCheckout,
  'pg-transaction-on-pool': requireReview(
    'Queries now share one checked-out connection, so a transaction that never held now commits or rolls back as a unit.',
    transactionOnPool,
  ),
  'pool-created-per-request-or-item': requireReview(
    'The pool moves to module scope, so its configuration is read once at load time and its lifecycle changes.',
    poolPerRequest,
  ),
  'prisma-transaction-client-escape': requireReview(
    'The call now rolls back with the transaction instead of persisting on its own.',
    transactionClientEscape,
  ),
  'prisma-scope-unverified': requireReview(
    'Adds a filter to the query, so it returns or changes fewer rows.',
    prismaScopeUnverified,
  ),
  'drizzle-scope-unverified': requireReview(
    'Adds a filter to the query, so it returns or changes fewer rows.',
    drizzleScopeUnverified,
  ),
  'drizzle-unfiltered-write': drizzleUnfilteredWrite,
};
