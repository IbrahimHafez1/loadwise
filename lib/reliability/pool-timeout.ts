// A `pg` pool or client created without `connectionTimeoutMillis`. node-postgres defaults it to 0, which waits for a
// connection forever, so a saturated pool or an unreachable database hangs every request instead of failing. Libraries
// whose defaults already time out (mysql2 and mysql `connectTimeout`, knex `acquireConnectionTimeout`, mongodb,
// ioredis, mssql, Sequelize, postgres.js) are deliberately left out.
import { ts } from '../performance/compiler.js';
import { walkNodes } from './walk.js';
import { isIgnoredSource } from './source-helpers.js';
import type { CheckerAdapter, Finding } from '../shared/types.js';
import type { NewExpression, SourceFile } from 'typescript';

const pgPackage = /[\\/]node_modules[\\/](?:@types[\\/])?pg(?:-pool)?[\\/]/;
const pgClassNames = new Set(['Pool', 'Client']);
const timeoutOption = 'connectionTimeoutMillis';

function constructedName(node: NewExpression): string | undefined {
  const callee = ts.skipOuterExpressions(node.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

function isPgConstruction(node: NewExpression, checker: CheckerAdapter): boolean {
  const name = constructedName(node);
  if (name === undefined || !pgClassNames.has(name)) return false;
  const declaration = checker.getResolvedSignature(node)?.declaration;
  return declaration !== undefined && pgPackage.test(declaration.getSourceFile().fileName);
}

// Whether the configuration visibly lacks the option. A configuration held elsewhere (a variable, a spread) may set it.
function lacksTimeout(node: NewExpression): boolean {
  const [config] = node.arguments ?? [];
  if (config === undefined) return true;
  const expression = ts.skipOuterExpressions(config);
  if (ts.isStringLiteralLike(expression)) return !/timeout/i.test(expression.text);
  if (!ts.isObjectLiteralExpression(expression)) return false;
  return !expression.properties.some(
    (property) =>
      ts.isSpreadAssignment(property) || (property.name !== undefined && property.name.getText() === timeoutOption),
  );
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
