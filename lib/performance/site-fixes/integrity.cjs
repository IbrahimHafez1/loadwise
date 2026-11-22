'use strict';

const {
  hasMultilineTemplate,
  ts,
  textOf,
  ancestor,
  calleeCall,
  indentationAt,
  lineStart,
  freshName,
  nameTaken,
  isPlainReference,
  mentionsIdentifier,
} = require('./helpers.cjs');

// site-fix.cjs drops hunks longer than this, so longer rewrites use the in-place form.
const maxInlineLines = 14;
const transactionStart = /^\s*(?:begin|start\s+transaction)\b/i;
const transactionEnd = /^\s*(?:commit|rollback|end|abort)\b/i;
const transactionControl = /^\s*(?:begin|start|commit|rollback|end|abort|savepoint|release|set\s+transaction)\b/i;

function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function unitFor(indentation) {
  return indentation.includes('\t') ? '\t' : '  ';
}

// Wraps the statements from `first` to `last` in `header` and `footer` lines, applying `replacements` inside.
// Re-indents the statements when the result stays a readable hunk; otherwise wraps them in place.
function wrapStatements({ text, sourceFile, first, last, header, footer, replacements }) {
  const start = first.getStart(sourceFile);
  const end = last.end;
  const firstLineStart = lineStart(text, start);
  if (text.slice(firstLineStart, start).trim()) return;
  const indentation = indentationAt(text, start);
  const unit = unitFor(indentation);
  const eol = eolOf(text);
  const outer = (lines) => lines.map((line) => indentation + line);
  let body = text.slice(start, end);
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    body = body.slice(0, replacement.start - start) + replacement.text + body.slice(replacement.end - start);
  }
  const bodyLines = body.split(/\r?\n/);
  if (
    !hasMultilineTemplate(sourceFile, start, end) &&
    header.length + bodyLines.length + footer.length <= maxInlineLines
  ) {
    const inner = bodyLines.map((line, index) => (index === 0 ? indentation + unit + line : line && unit + line));
    const lines = [...outer(header), ...inner, ...outer(footer)];
    return { edits: [{ start, end, text: lines.join(eol).slice(indentation.length) }], reindented: true };
  }
  return {
    edits: [
      { start: firstLineStart, end: firstLineStart, text: outer(header).join(eol) + eol },
      ...replacements,
      { start: end, end, text: eol + outer(footer).join(eol) },
    ],
    reindented: false,
  };
}

const formatterNote = ' Run your formatter to re-indent the wrapped statements.';

// ---- pg-unreleased-checkout ----

function unreleasedCheckout({ node }) {
  const connect = calleeCall(node);
  if (!connect || !ts.isPropertyAccessExpression(connect.expression) || connect.expression.name.text !== 'connect')
    return;
  const pool = connect.expression.expression;
  if (!isPlainReference(pool)) return;
  let receiver = connect;
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

function queryText(call) {
  const [argument] = call.arguments;
  if (!argument) return;
  if (ts.isStringLiteralLike(argument)) return argument.text;
  if (!ts.isObjectLiteralExpression(argument)) return;
  const property = argument.properties.find(
    (candidate) => ts.isPropertyAssignment(candidate) && candidate.name.getText() === 'text',
  );
  return property && ts.isStringLiteralLike(property.initializer) ? property.initializer.text : undefined;
}

function isQueryAccess(access) {
  if (ts.isPropertyAccessExpression(access)) return access.name.text === 'query';
  return (
    ts.isElementAccessExpression(access) &&
    ts.isStringLiteralLike(access.argumentExpression) &&
    access.argumentExpression.text === 'query'
  );
}

// Every expression in `root` spelled like `poolText`, except member names such as the `pool` in `this.pool`.
function referencesTo(root, poolText) {
  const found = [];
  (function visit(child) {
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

function declaredNames(statement) {
  if (!ts.isVariableStatement(statement)) return [];
  const names = [];
  for (const declaration of statement.declarationList.declarations) collectNames(declaration.name, names);
  return names;
}

function collectNames(name, names) {
  if (ts.isIdentifier(name)) names.push(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) collectNames(element.name, names);
}

function transactionOnPool({ node, sourceFile, text }) {
  const access = node.parent;
  if (!access || !isQueryAccess(access) || !isPlainReference(access.expression)) return;
  const poolText = textOf(access.expression);
  const owner = ancestor(access, ts.isFunctionLike);
  const body = owner?.body;
  if (!body || !ts.isBlock(body)) return;
  const receivers = referencesTo(body, poolText);
  const queries = receivers
    .map((receiver) => receiver.parent)
    .filter(
      (parent) => isQueryAccess(parent) && ts.isCallExpression(parent.parent) && parent.parent.expression === parent,
    )
    .map((parent) => parent.parent);
  const topIndex = (inner) => body.statements.indexOf(ancestor(inner, (current) => current.parent === body));
  const begin = queries.find((call) => transactionStart.test(queryText(call) ?? ''));
  const ends = queries.filter((call) => transactionEnd.test(queryText(call) ?? ''));
  if (!begin || !ends.length) return;
  const firstIndex = topIndex(begin);
  const lastIndex = topIndex(ends.at(-1));
  const findingIndex = topIndex(access);
  if (firstIndex < 0 || findingIndex < firstIndex || findingIndex > lastIndex) return;
  const region = body.statements.slice(firstIndex, lastIndex + 1);
  const regionStart = region[0].getStart(sourceFile);
  const regionEnd = region.at(-1).end;
  const inRegion = (child) => child.getStart(sourceFile) >= regionStart && child.end <= regionEnd;
  // Passing the pool to a helper or checking out from it inside the range would still bypass the client.
  const regionReceivers = receivers.filter(inRegion);
  const regionQueries = queries.filter(inRegion);
  if (regionReceivers.length !== regionQueries.length || regionQueries[0] !== begin) return;
  // `finally` releases the client as soon as the block exits, so every query must have settled by then.
  const settled = (call) => ts.isAwaitExpression(call.parent) && ancestor(call, ts.isFunctionLike) === owner;
  if (!regionQueries.every(settled)) return;
  // Wrapping the range in try would hide its declarations from the statements after it.
  const later = body.statements.slice(lastIndex + 1);
  for (const statement of region) {
    if (declaredNames(statement).some((name) => later.some((next) => mentionsIdentifier(next, name)))) return;
  }
  const client = freshName(sourceFile, 'client');
  if (!client) return;
  const unit = unitFor(indentationAt(text, regionStart));
  const rollsBack = regionQueries.some((call) => /^\s*(?:rollback|abort)\b/i.test(queryText(call) ?? ''));
  const footer = [
    ...(rollsBack ? [] : ['} catch (error) {', `${unit}await ${client}.query('ROLLBACK');`, `${unit}throw error;`]),
    '} finally {',
    `${unit}${client}.release();`,
    '}',
  ];
  const wrapped = wrapStatements({
    text,
    sourceFile,
    first: region[0],
    last: region.at(-1),
    header: [`const ${client} = await ${poolText}.connect();`, 'try {'],
    footer,
    replacements: regionReceivers.map((receiver) => ({
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

// ---- pool-created-per-request-or-item ----

const closingMethods = new Set(['end', 'close', 'quit', 'disconnect', '$disconnect']);
const declarationKinds = new Set([
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.EnumDeclaration,
]);

function bindingNamesWithin(root) {
  const names = new Set();
  (function visit(child) {
    if (ts.isIdentifier(child) && declarationKinds.has(child.parent.kind) && child.parent.name === child)
      names.add(child.text);
    ts.forEachChild(child, visit);
  })(root);
  return names;
}

function isReference(identifier) {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === identifier) return false;
  return true;
}

function topLevelDeclaration(sourceFile, name) {
  return sourceFile.statements.find((statement) => {
    if (ts.isVariableStatement(statement))
      return statement.declarationList.declarations.some((declaration) => bindingNamesWithin(declaration).has(name));
    if (ts.isImportDeclaration(statement))
      return bindingNamesWithin(statement).has(name) || importsName(statement, name);
    return statement.name?.text === name;
  });
}

function importsName(statement, name) {
  const clause = statement.importClause;
  if (!clause) return false;
  if (clause.name?.text === name) return true;
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return bindings.name.text === name;
  return bindings.elements.some((element) => element.name.text === name);
}

// True when every name the constructor reads already exists, with its final value, at module scope above `topLevel`.
function readableAtModuleScope(creation, topLevel, sourceFile) {
  const local = bindingNamesWithin(topLevel);
  let readable = true;
  (function visit(child) {
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

// The whole lines holding `statement` with the line break before them, when nothing else shares those lines.
// Taking the preceding break keeps the removal inside the hunk that shows it.
function wholeLines(text, statement) {
  const start = lineStart(text, statement.getStart());
  const lineBreak = text.indexOf('\n', statement.end);
  let end = lineBreak === -1 ? text.length : lineBreak;
  if (text[end - 1] === '\r') end--;
  if (!start || text.slice(start, statement.getStart()).trim() || text.slice(statement.end, end).trim()) return;
  return { start: start - (text[start - 2] === '\r' ? 2 : 1), end };
}

function closingStatements(scope, name) {
  const statements = [];
  let usable = true;
  (function visit(child) {
    if (!usable) return;
    if (ts.isIdentifier(child) && child.text === name && isReference(child)) {
      const access = child.parent;
      const call = access.parent;
      if (
        ts.isPropertyAccessExpression(access) &&
        closingMethods.has(access.name.text) &&
        ts.isCallExpression(call) &&
        call.expression === access
      ) {
        let holder = call.parent;
        if (ts.isAwaitExpression(holder)) holder = holder.parent;
        if (ts.isExpressionStatement(holder) && ts.isBlock(holder.parent)) statements.push(holder);
        else usable = false;
      }
    }
    ts.forEachChild(child, visit);
  })(scope);
  return usable ? statements : undefined;
}

function connects(scope, name) {
  let found = false;
  (function visit(child) {
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

function poolPerRequest({ finding, node, sourceFile, text }) {
  const creation = ts.isNewExpression(node) ? node : calleeCall(node);
  const declaration = creation?.parent;
  if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.initializer !== creation) return;
  if (!ts.isIdentifier(declaration.name)) return;
  const list = declaration.parent;
  const statement = list.parent;
  if (!(list.flags & ts.NodeFlags.Const) || list.declarations.length !== 1 || !ts.isVariableStatement(statement))
    return;
  const scope = statement.parent;
  if (!ts.isBlock(scope) || statement.modifiers?.length) return;
  const name = declaration.name.text;
  const topLevel = ancestor(statement, (current) => current.parent && ts.isSourceFile(current.parent));
  if (!topLevel || topLevelDeclaration(sourceFile, name)) return;
  if (!readableAtModuleScope(creation, topLevel, sourceFile)) return;
  if (hasMultilineTemplate(sourceFile, statement.getStart(), statement.end)) return;
  // A shared Redis or Mongo client cannot be connected again on each call.
  if (/^(?:redis|@redis\/client|mongodb)\./.test(finding.message) && connects(scope, name)) return;
  const closing = closingStatements(scope, name);
  if (!closing) return;
  const removals = [statement, ...closing].map((removed) => wholeLines(text, removed));
  if (removals.some((removal) => !removal)) return;

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
    note:
      'Created once when the module loads and shared by every call, so its configuration must be available at import time.' +
      (closing.length
        ? ' The per-call close was removed; close it once at shutdown instead.'
        : ' Close it at shutdown.'),
  };
}

// ---- prisma-transaction-client-escape ----

function transactionClientEscape({ node, sourceFile }) {
  const method = node.parent;
  if (!ts.isPropertyAccessExpression(method) || method.name !== node) return;
  const delegate = method.expression;
  if (!ts.isPropertyAccessExpression(delegate)) return;
  const client = delegate.expression;
  const callback = ancestor(method, ts.isFunctionLike);
  let argument = callback;
  while (ts.isParenthesizedExpression(argument?.parent)) argument = argument.parent;
  const transaction = argument?.parent;
  if (
    !callback ||
    !ts.isCallExpression(transaction) ||
    transaction.arguments[0] !== argument ||
    !ts.isPropertyAccessExpression(transaction.expression) ||
    transaction.expression.name.text !== '$transaction' ||
    textOf(transaction.expression.expression) !== textOf(client)
  )
    return;
  const [parameter] = callback.parameters;
  const edits = [];
  let name;
  if (parameter) {
    if (!ts.isIdentifier(parameter.name)) return;
    name = parameter.name.text;
    // A nested binding with the same name could make the replacement read something else.
    if (bindingNamesWithin(callback.body).has(name)) return;
  } else {
    // Without parameters both arrow and function callbacks have parentheses to receive the new one.
    name = freshName(sourceFile, 'tx');
    if (!name) return;
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
function plainObject(node) {
  return (
    ts.isObjectLiteralExpression(node) &&
    node.properties.every(
      (property) =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        !ts.isComputedPropertyName(property.name),
    )
  );
}

function propertyNamed(object, name) {
  return object.properties.find(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      !ts.isComputedPropertyName(property.name) &&
      property.name.text === name,
  );
}

// Adds `property` as the first entry of an object literal, following its single- or multi-line layout.
function addFirstProperty(object, property, text) {
  const [first] = object.properties;
  if (!first) return { start: object.getStart(), end: object.end, text: `{ ${property} }` };
  const firstStart = first.getStart();
  const multiline = text.slice(object.getStart(), firstStart).includes('\n');
  const separator = multiline ? ',' + eolOf(text) + indentationAt(text, firstStart) : ', ';
  return { start: firstStart, end: firstStart, text: property + separator };
}

function prismaScopeUnverified({ finding, node, text }) {
  const field = /Constrain where\.([A-Za-z_][A-Za-z0-9_]*) to/.exec(finding.message)?.[1];
  const access = node.parent;
  const call = access?.parent;
  if (!field || !ts.isCallExpression(call) || call.expression !== access || call.arguments.length !== 1) return;
  const options = call.arguments[0];
  if (!plainObject(options) || finding.verifiedScopeField !== field) return;
  const where = propertyNamed(options, 'where');
  const operation = ts.isPropertyAccessExpression(access) ? access.name.text : access.argumentExpression.text;
  let edit;
  if (!where) edit = addFirstProperty(options, `where: { ${field} }`, text);
  else if (ts.isPropertyAssignment(where) && ts.isObjectLiteralExpression(where.initializer)) {
    if (!plainObject(where.initializer)) return;
    // An existing filter on the field would conflict; which value is right is a human decision.
    if (propertyNamed(where.initializer, field)) return;
    edit = addFirstProperty(where.initializer, field, text);
  } else {
    // Unique lookups need their unique key at the top level, which AND would hide.
    if (uniqueOperations.has(operation)) return;
    const condition = ts.isShorthandPropertyAssignment(where) ? 'where' : textOf(where.initializer);
    edit = { start: where.getStart(), end: where.end, text: `where: { AND: [${condition}, { ${field} }] }` };
  }
  return {
    edits: [edit],
    note: `Filters by the \`${field}\` declared above. The checker verified its value comes from the configured authorization function.`,
  };
}

// ---- drizzle helpers ----

// Local names for drizzle-orm exports, plus the edits that import the missing ones.
function drizzleImports(sourceFile, names) {
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  const declaration = imports.find(
    (statement) =>
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === 'drizzle-orm' &&
      !statement.importClause?.isTypeOnly &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings),
  );
  const elements = declaration?.importClause.namedBindings.elements ?? [];
  const local = {};
  const missing = [];
  for (const name of names) {
    const element = elements.find(
      (candidate) => !candidate.isTypeOnly && (candidate.propertyName ?? candidate.name).text === name,
    );
    if (element) local[name] = element.name.text;
    else if (nameTaken(sourceFile, name)) return;
    else {
      local[name] = name;
      missing.push(name);
    }
  }
  if (!missing.length) return { local, edits: [] };
  if (elements.length) {
    const position = elements.at(-1).end;
    return { local, edits: [{ start: position, end: position, text: ', ' + missing.join(', ') }] };
  }
  if (declaration) {
    const bindings = declaration.importClause.namedBindings;
    return { local, edits: [{ start: bindings.getStart(), end: bindings.end, text: `{ ${missing.join(', ')} }` }] };
  }
  const text = sourceFile.text;
  const quote = imports[0]?.moduleSpecifier.getText().startsWith('"') ? '"' : "'";
  const line = `import { ${missing.join(', ')} } from ${quote}drizzle-orm${quote};`;
  const last = imports.at(-1);
  if (last) return { local, edits: [{ start: last.end, end: last.end, text: eolOf(text) + line }] };
  return { local, edits: [{ start: 0, end: 0, text: line + eolOf(text) }] };
}

// The builder chain that starts at the reported `db.select` / `db.update` / `db.delete`.
function drizzleChain(node) {
  const rootAccess = node.parent;
  const rootCall = rootAccess?.parent;
  if (
    !ts.isPropertyAccessExpression(rootAccess) ||
    !ts.isCallExpression(rootCall) ||
    rootCall.expression !== rootAccess
  )
    return;
  const steps = [];
  for (let current = rootCall; ;) {
    const access = current.parent;
    const call = access?.parent;
    if (!ts.isPropertyAccessExpression(access) || !ts.isCallExpression(call) || call.expression !== access) break;
    steps.push({ name: access.name.text, call });
    current = call;
  }
  return { operation: node.text, rootCall, steps };
}

// ---- drizzle-scope-unverified ----

function drizzleScopeUnverified({ finding, node, sourceFile }) {
  const column = /using eq\(([^,]+), <authorized scope>\)\.$/.exec(finding.message)?.[1];
  const field = column && /^[^.[]+\.([A-Za-z_$][\w$]*)$/.exec(column)?.[1];
  const chain = field && drizzleChain(node);
  if (!chain) return;
  const wheres = chain.steps.filter((step) => step.name === 'where');
  const anchor =
    chain.operation === 'select'
      ? chain.steps.find((step) => step.name === 'from')?.call
      : chain.operation === 'update'
        ? chain.steps.find((step) => step.name === 'set')?.call
        : chain.operation === 'delete' && chain.rootCall;
  const table = chain.operation === 'select' ? anchor?.arguments[0] : chain.rootCall.arguments[0];
  if (!anchor || !table || !isPlainReference(table) || wheres.length > 1) return;
  if (finding.verifiedScopeField !== field) return;
  const [where] = wheres;
  if (where && where.call.arguments.length !== 1) return;
  const imports = drizzleImports(sourceFile, where ? ['eq', 'and'] : ['eq']);
  if (!imports) return;
  const condition = `${imports.local.eq}(${textOf(table)}.${field}, ${field})`;
  const edit = where
    ? {
        start: where.call.arguments[0].getStart(),
        end: where.call.arguments[0].end,
        text: `${imports.local.and}(${condition}, ${textOf(where.call.arguments[0])})`,
      }
    : { start: anchor.end, end: anchor.end, text: `.where(${condition})` };
  return {
    edits: [...imports.edits, edit],
    note: `Filters by the \`${field}\` declared above. The checker verified its value comes from the configured authorization function.`,
  };
}

// ---- drizzle-unfiltered-write ----

// The rule also counts `void work()` and `and(void work())` as no filter; replacing such an argument would drop the
// call, so only arguments built from names, literals and Drizzle's `and`/`or` are replaced.
function isEffectFree(node) {
  if (ts.isCallExpression(node) && !(ts.isIdentifier(node.expression) && ['and', 'or'].includes(node.expression.text)))
    return false;
  if (
    ts.isNewExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isDeleteExpression(node) ||
    ts.isPrefixUnaryExpression(node) ||
    ts.isPostfixUnaryExpression(node) ||
    (ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
  )
    return false;
  return !ts.forEachChild(node, (child) => !isEffectFree(child));
}

function drizzleUnfilteredWrite({ finding, node, sourceFile }) {
  // Only the same-boolean UPDATE has a filter implied by the code itself; any other filter would be invented.
  if (!finding.message.startsWith('This unfiltered UPDATE rewrites every row with the same boolean')) return;
  const chain = drizzleChain(node);
  if (!chain || chain.operation !== 'update' || chain.steps.some((step) => step.name === 'returning')) return;
  const table = chain.rootCall.arguments[0];
  const set = chain.steps.find((step) => step.name === 'set')?.call;
  const assignments = set?.arguments[0];
  if (!table || !isPlainReference(table) || !assignments || !ts.isObjectLiteralExpression(assignments)) return;
  const [assignment] = assignments.properties;
  if (!ts.isPropertyAssignment(assignment) || !ts.isIdentifier(assignment.name)) return;
  const wheres = chain.steps.filter((step) => step.name === 'where');
  if (wheres.length > 1 || (wheres[0] && wheres[0].call.arguments.length > 1)) return;
  if (wheres[0]?.call.arguments.length && !isEffectFree(wheres[0].call.arguments[0])) return;
  // A NOT NULL column never holds null, so `ne` alone is exact.
  const needsNullCheck = !finding.message.includes('declared NOT NULL');
  const imports = drizzleImports(sourceFile, needsNullCheck ? ['or', 'ne', 'isNull'] : ['ne']);
  if (!imports) return;
  const { or, ne, isNull } = imports.local;
  const column = `${textOf(table)}.${assignment.name.text}`;
  const notEqual = `${ne}(${column}, ${textOf(assignment.initializer)})`;
  const condition = needsNullCheck ? `${or}(${notEqual}, ${isNull}(${column}))` : notEqual;
  const where = wheres[0]?.call;
  const edit = !where
    ? { start: set.end, end: set.end, text: `.where(${condition})` }
    : where.arguments.length
      ? { start: where.arguments[0].getStart(), end: where.arguments[0].end, text: condition }
      : { start: where.end - 1, end: where.end - 1, text: condition };
  return {
    edits: [...imports.edits, edit],
    requiresReview: true,
    note: 'Rows that already hold this value are no longer rewritten, so the affected-row count drops and update triggers or row locks no longer apply to them. Keep the old form if anything depends on those.',
  };
}

module.exports = {
  'pg-unreleased-checkout': unreleasedCheckout,
  'pg-transaction-on-pool': transactionOnPool,
  'pool-created-per-request-or-item': poolPerRequest,
  'prisma-transaction-client-escape': transactionClientEscape,
  'prisma-scope-unverified': prismaScopeUnverified,
  'drizzle-scope-unverified': drizzleScopeUnverified,
  'drizzle-unfiltered-write': drizzleUnfilteredWrite,
};
