'use strict';

const { syntax: ts } = require('./compiler.cjs');

const { analyzeFragment } = require('./pg-fragments.cjs');

const pgPackages = ['pg', '@types/pg', 'pg-pool', '@types/pg-pool'];
const poolTypes = ['Pool'];
const queryTypes = ['Pool', 'Client', 'ClientBase', 'PoolClient'];
const mode = '(?:isolation level (?:serializable|repeatable read|read (?:un)?committed)|read (?:write|only)|(?:not )?deferrable)';
const modes = `${mode}(?:(?:,| )${mode})*`;
const transactionStart = new RegExp(`^(?:begin(?: work| transaction)?|start transaction)(?: ${modes})?$`, 'i');
const setTransaction = new RegExp(`^set transaction ${modes}$`, 'i');
const transactionEnd = /^(?:end|abort|commit|rollback)(?: work| transaction)?(?: and (?:no )?chain)?$/i;
const savepoint = /^(?:savepoint|release(?: savepoint)?|rollback(?: work| transaction)? to(?: savepoint)?) [a-z_][a-z0-9_$]*$/i;

function transactionControl(text) {
  // Restrict recognition to one command. A complete transaction submitted in
  // one query uses one connection, and COMMIT PREPARED can use another session.
  if (!/^\s*(?:begin\b|start\b|set\b|end\b|abort\b|commit\b|rollback\b|release\b|savepoint\b|--|\/\*)/i.test(text)) return false;
  if (/['"]/.test(text)) return false;
  const statement = text.replace(/--[^\r\n]*|\/\*[\s\S]*?\*\//g, ' ').trim()
    .replace(/;$/, '').trimEnd().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',');
  return transactionStart.test(statement) || transactionEnd.test(statement) ||
    savepoint.test(statement) || setTransaction.test(statement);
}

function textArgument(argument) {
  const options = ts.skipOuterExpressions(argument);
  if (!ts.isObjectLiteralExpression(options)) return options;

  let text;
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return;
    let name = property.name;
    if (ts.isComputedPropertyName(name)) {
      name = ts.skipOuterExpressions(name.expression);
      if (!ts.isStringLiteralLike(name) && !ts.isNumericLiteral(name)) return;
    }
    // pg delegates to config.submit when it is callable. An unknown spread
    // anywhere, or a custom prototype, can supply that separate contract.
    if (name.text === 'submit' || name.text === '__proto__') return;
    if (name.text === 'text') text = ts.isPropertyAssignment(property) ? ts.skipOuterExpressions(property.initializer) : undefined;
  }
  return text;
}

function usesDriverQuery(call, receiver, types, context) {
  if (!context.isPackageType(receiver, pgPackages, types)) return false;
  const declaration = context.checker.getResolvedSignature(call)?.declaration;
  if (!declaration || !queryTypes.includes(declaration.parent?.name?.text)) return false;
  const filename = declaration.getSourceFile().fileName.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const start = filename.lastIndexOf(marker);
  return start >= 0 && pgPackages.some(name => filename.startsWith(name + '/', start + marker.length));
}

function checkPgIntegrity(call, context) {
  const access = call.expression;
  const method = ts.isPropertyAccessExpression(access) ? access.name :
    ts.isElementAccessExpression(access) && ts.isStringLiteralLike(access.argumentExpression) ? access.argumentExpression : undefined;
  if (method?.text !== 'query' || !call.arguments.length) return;
  const query = textArgument(call.arguments[0]);
  if (!query) return;

  let text;
  if (ts.isStringLiteralLike(query)) text = query.text;
  else {
    const concatenation = ts.isBinaryExpression(query) && query.operatorToken.kind === ts.SyntaxKind.PlusToken;
    const assembled = ts.isTemplateExpression(query) || concatenation;
    if (!assembled && !ts.isIdentifier(query)) return;
    if (assembled && !usesDriverQuery(call, access.expression, queryTypes, context)) return;
    if (concatenation && !(context.checker.getTypeAtLocation(query).flags & ts.TypeFlags.StringLike)) return;
    text = analyzeFragment(query, context.checker);
    if (assembled && text === undefined) {
      context.report(query, 'pg-dynamic-query-text',
        'A runtime fragment is inserted into SQL text. Bind data through $1-style placeholders and values. Validate dynamic identifiers against an allowlist and quote them correctly.');
    }
  }
  if (typeof text === 'string' && transactionControl(text) && usesDriverQuery(call, access.expression, poolTypes, context)) {
    context.report(method, 'pg-transaction-on-pool',
      'Each pool.query() can use a different connection. Check out one client for the transaction and release it in finally.');
  }
}

module.exports = { checkPgIntegrity };
