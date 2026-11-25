import { ts } from './compiler.js';

import { analyzeFragment } from './pg-fragments.js';
import type { CallExpression, Expression, MemberName, PropertyName, StringLiteralLike } from 'typescript';
import type { RuleContext } from '../shared/types.js';

const pgPackages = ['pg', '@types/pg', 'pg-pool', '@types/pg-pool'];
const poolTypes = ['Pool'];
const queryTypes = ['Pool', 'Client', 'ClientBase', 'PoolClient'];
const mode =
  '(?:isolation level (?:serializable|repeatable read|read (?:un)?committed)|read (?:write|only)|(?:not )?deferrable)';
const modes = `${mode}(?:(?:,| )${mode})*`;
const transactionStart = new RegExp(`^(?:begin(?: work| transaction)?|start transaction)(?: ${modes})?$`, 'i');
const setTransaction = new RegExp(`^set transaction ${modes}$`, 'i');
const transactionEnd = /^(?:end|abort|commit|rollback)(?: work| transaction)?(?: and (?:no )?chain)?$/i;
const savepoint =
  /^(?:savepoint|release(?: savepoint)?|rollback(?: work| transaction)? to(?: savepoint)?) [a-z_][a-z0-9_$]*$/i;

function transactionControl(text: string) {
  // Restrict recognition to one command. A complete transaction submitted in
  // one query uses one connection, and COMMIT PREPARED can use another session.
  if (!/^\s*(?:begin\b|start\b|set\b|end\b|abort\b|commit\b|rollback\b|release\b|savepoint\b|--|\/\*)/i.test(text))
    return false;
  if (/['"]/.test(text)) return false;
  const statement = text
    .replaceAll(/--[^\r\n]*|\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;$/, '')
    .trimEnd()
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/\s*,\s*/g, ',');
  return (
    transactionStart.test(statement) ||
    transactionEnd.test(statement) ||
    savepoint.test(statement) ||
    setTransaction.test(statement)
  );
}

// The name a property is written with; a computed name counts only when it is a string or number
// literal.
function propertyNameText(name: PropertyName): string | undefined {
  if (!ts.isComputedPropertyName(name)) return name.text;
  const key = ts.skipOuterExpressions(name.expression);
  return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : undefined;
}

function textArgument(argument: Expression): Expression | undefined {
  const options = ts.skipOuterExpressions(argument);
  if (!ts.isObjectLiteralExpression(options)) return options;

  let text: Expression | undefined;
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return;
    const name = propertyNameText(property.name);
    if (name === undefined) return;
    // pg delegates to config.submit when it is callable. An unknown spread
    // anywhere, or a custom prototype, can supply that separate contract.
    if (name === 'submit' || name === '__proto__') return;
    if (name === 'text')
      text = ts.isPropertyAssignment(property) ? ts.skipOuterExpressions(property.initializer) : undefined;
  }
  return text;
}

function usesDriverQuery(call: CallExpression, receiver: Expression, types: readonly string[], context: RuleContext) {
  if (!context.isPackageType(receiver, pgPackages, types)) return false;
  const declaration = context.checker.getResolvedSignature(call)?.declaration;
  if (!declaration) return false;
  const declaringType = declaration.parent;
  const declaringName =
    ts.isClassLike(declaringType) || ts.isInterfaceDeclaration(declaringType) ? declaringType.name?.text : undefined;
  if (declaringName === undefined || !queryTypes.includes(declaringName)) return false;
  const filename = declaration.getSourceFile().fileName.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const start = filename.lastIndexOf(marker);
  return start >= 0 && pgPackages.some((name) => filename.startsWith(name + '/', start + marker.length));
}

// The `query` name node of `client.query(...)` or `client['query'](...)`, or undefined.
function queryMethod(call: CallExpression): MemberName | StringLiteralLike | undefined {
  const access = call.expression;
  const method = ts.isPropertyAccessExpression(access)
    ? access.name
    : ts.isElementAccessExpression(access) && ts.isStringLiteralLike(access.argumentExpression)
      ? access.argumentExpression
      : undefined;
  return method?.text === 'query' && call.arguments.length ? method : undefined;
}

function checkPgIntegrity(call: CallExpression, context: RuleContext) {
  const access = call.expression;
  const method = queryMethod(call);
  if (!method) return;
  // queryMethod found a name, so the callee is a property or element access.
  if (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) return;
  const query = textArgument(call.arguments[0]);
  if (!query) return;

  let text: ReturnType<typeof analyzeFragment>;
  if (ts.isStringLiteralLike(query)) text = query.text;
  else {
    const concatenation = ts.isBinaryExpression(query) && query.operatorToken.kind === ts.SyntaxKind.PlusToken;
    const assembled = ts.isTemplateExpression(query) || concatenation;
    if (!assembled && !ts.isIdentifier(query)) return;
    if (assembled && !usesDriverQuery(call, access.expression, queryTypes, context)) return;
    if (concatenation && !(context.checker.getTypeAtLocation(query).flags & ts.TypeFlags.StringLike)) return;
    text = analyzeFragment(query, context.checker);
  }
  if (
    typeof text === 'string' &&
    transactionControl(text) &&
    usesDriverQuery(call, access.expression, poolTypes, context)
  ) {
    context.report(
      method,
      'pg-transaction-on-pool',
      'Each pool.query() can run on a different connection, so BEGIN and COMMIT do not share one transaction. Use `const client = await pool.connect()`, run every statement on `client`, and call `client.release()` in finally.',
    );
  }
}

export { checkPgIntegrity, queryMethod, textArgument, usesDriverQuery, queryTypes };
