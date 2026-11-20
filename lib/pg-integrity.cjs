'use strict';

const { syntax: ts } = require('./compiler.cjs');

const { analyzeFragment } = require('./pg-fragments.cjs');

const pgPackages = ['pg', '@types/pg', 'pg-pool', '@types/pg-pool'];
const queryTypes = ['Pool', 'Client', 'ClientBase', 'PoolClient'];

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
    if (name.text === 'text')
      text = ts.isPropertyAssignment(property) ? ts.skipOuterExpressions(property.initializer) : undefined;
  }
  return text;
}

function usesDriverQuery(call, receiver, context) {
  if (!context.isPackageType(receiver, pgPackages, queryTypes)) return false;
  const declaration = context.checker.getResolvedSignature(call)?.declaration;
  if (!declaration || !queryTypes.includes(declaration.parent?.name?.text)) return false;
  const filename = declaration.getSourceFile().fileName.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const start = filename.lastIndexOf(marker);
  return start >= 0 && pgPackages.some((name) => filename.startsWith(name + '/', start + marker.length));
}

function checkPgIntegrity(call, context) {
  const access = call.expression;
  const method = ts.isPropertyAccessExpression(access)
    ? access.name
    : ts.isElementAccessExpression(access) && ts.isStringLiteralLike(access.argumentExpression)
      ? access.argumentExpression
      : undefined;
  if (method?.text !== 'query' || !call.arguments.length) return;
  const query = textArgument(call.arguments[0]);
  if (!query) return;
  const concatenation = ts.isBinaryExpression(query) && query.operatorToken.kind === ts.SyntaxKind.PlusToken;
  if (!ts.isTemplateExpression(query) && !concatenation) return;
  if (!usesDriverQuery(call, access.expression, context)) return;
  if (concatenation && !(context.checker.getTypeAtLocation(query).flags & ts.TypeFlags.StringLike)) return;
  if (analyzeFragment(query, context.checker) === undefined) {
    context.report(
      query,
      'pg-dynamic-query-text',
      'A runtime value is concatenated into SQL text, which defeats parameter binding and the plan cache and allows injection. Pass data as `$1` placeholders with a values array; pick dynamic identifiers from a fixed allowlist.',
    );
  }
}

module.exports = { checkPgIntegrity };
