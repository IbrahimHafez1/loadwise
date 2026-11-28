// A `pg` pool or client created without `connectionTimeoutMillis`. node-postgres defaults it to 0, which waits for a
// connection forever, so a saturated pool or an unreachable database hangs every request instead of failing. Libraries
// whose defaults already time out (mysql2 and mysql `connectTimeout`, knex `acquireConnectionTimeout`, mongodb,
// ioredis, mssql, Sequelize, postgres.js) are deliberately left out.
import { ts } from '../performance/compiler.js';
import { walkNodes } from './walk.js';
import { isIgnoredSource } from './source-helpers.js';
import type { CheckerAdapter, Finding } from '../shared/types.js';
import type { Expression, NewExpression, ObjectLiteralElementLike, SourceFile } from 'typescript';

const pgPackage = /[\\/]node_modules[\\/](?:@types[\\/])?pg(?:-pool)?[\\/]/;
const pgClassNames = new Set(['Pool', 'Client']);
const timeoutOption = 'connectionTimeoutMillis';

// The constructor is identified by the class it resolves to, so an import alias (`Pool as PgPool`) is still checked
// and an unrelated local class named `Pool` is not.
function isPgConstruction(node: NewExpression, checker: CheckerAdapter): boolean {
  const declaration = checker.getResolvedSignature(node)?.declaration;
  if (declaration === undefined || !pgPackage.test(declaration.getSourceFile().fileName)) return false;
  const owner = declaration.parent;
  return ts.isClassLike(owner) && owner.name !== undefined && pgClassNames.has(owner.name.text);
}

function propertyName(property: ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  if (name === undefined) return;
  if (ts.isComputedPropertyName(name))
    return ts.isStringLiteralLike(name.expression) ? name.expression.text : undefined;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

// `connectionTimeoutMillis: 0` and `undefined` are the default, so they do not bound the wait.
function disablesTimeout(value: Expression): boolean {
  const expression = ts.skipOuterExpressions(value);
  if (ts.isIdentifier(expression)) return expression.text === 'undefined';
  return ts.isNumericLiteral(expression) && Number(expression.text) === 0;
}

// A later property overrides an earlier one, so the last spread or `connectionTimeoutMillis` property decides. A spread
// may supply the timeout, so it counts as setting it.
function setsTimeout(properties: readonly ObjectLiteralElementLike[]): boolean {
  for (const property of properties.toReversed()) {
    if (ts.isSpreadAssignment(property)) return true;
    if (propertyName(property) !== timeoutOption) continue;
    return !ts.isPropertyAssignment(property) || !disablesTimeout(property.initializer);
  }
  return false;
}

// Whether the configuration visibly lacks the option. A configuration held elsewhere (a variable, a spread) may set it.
// A connection string never sets it: pg reads the timer from the `connectionTimeoutMillis` property of the argument, so
// a query parameter in the URL does not enable it.
function lacksTimeout(node: NewExpression): boolean {
  const [config] = node.arguments ?? [];
  if (config === undefined) return true;
  const expression = ts.skipOuterExpressions(config);
  if (ts.isStringLiteralLike(expression)) return true;
  if (!ts.isObjectLiteralExpression(expression)) return false;
  return !setsTimeout(expression.properties);
}

function checkPoolTimeout(sourceFile: SourceFile, file: string, checker: CheckerAdapter): Finding[] {
  if (!sourceFile.text.includes('new ') || isIgnoredSource(sourceFile, file)) return [];
  const findings: Finding[] = [];
  walkNodes(sourceFile, (node) => {
    if (!ts.isNewExpression(node) || !isPgConstruction(node, checker) || !lacksTimeout(node)) return;
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      file,
      line: position.line + 1,
      column: position.character + 1,
      ruleId: 'pool-without-connection-timeout',
      message:
        'This pg connection is created without connectionTimeoutMillis, whose default of 0 waits forever, so an exhausted pool or unreachable database hangs the caller. Set connectionTimeoutMillis to a few seconds.',
    });
  });
  return findings;
}

export { checkPoolTimeout };
