import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { check } from '../../lib/performance/guard-queries.cjs';
import { createRuleContext } from './helpers.cjs';
import type { Node } from 'typescript';

test('guard registration discovery stops at the file budget within a directory', (context) => {
  const fileLimit = 20_000;
  const root = path.join(__dirname, 'virtual-guard-budget');
  const file = (name: string) => ({ name, isDirectory: () => false });
  const directory = (name: string) => ({ name, isDirectory: () => true });
  const visitedDirectories: string[] = [];
  let readCount = 0;
  context.mock.method(fs, 'existsSync', (filename: string) => filename === path.join(root, 'package.json'));
  context.mock.method(fs, 'readdirSync', (filename: string) => {
    visitedDirectories.push(path.normalize(filename));
    if (path.normalize(filename) === root)
      return [
        directory('nested'),
        directory('node_modules'),
        directory('.git'),
        file('types.d.ts'),
        file('readme.md'),
        file('unreadable.ts'),
        ...Array.from({ length: fileLimit - 2 }, (_, index) => file(`file-${index}.js`)),
      ];
    return [file('at-limit.ts'), file('over-budget.ts')];
  });
  context.mock.method(fs, 'readFileSync', (filename: string) => {
    readCount++;
    if (filename.endsWith('unreadable.ts')) throw new Error('unreadable');
    if (filename.endsWith('at-limit.ts')) return 'app.useGlobalGuards(AtLimitGuard);';
    if (filename.endsWith('over-budget.ts')) return 'app.useGlobalGuards(OverBudgetGuard);';
    return '';
  });
  const guard = (name: string) =>
    `class ${name} implements CanActivate { canActivate() { return pool.query("select 1"); } }`;
  const source = ts.createSourceFile(
    path.join(root, 'guard.ts'),
    guard('AtLimitGuard') + '\n' + guard('OverBudgetGuard'),
    ts.ScriptTarget.Latest,
    true,
  );
  const reports: string[] = [];
  // The guard's declarations come from a source file outside this empty program, so symbol lookups
  // resolve to nothing.
  const program = ts.createProgram([], {});
  const queryContext = createRuleContext(program, {
    checker: { ...program.getTypeChecker(), getSymbolAtLocation: () => undefined },
    isPackageType: () => true,
    report: (_node: Node, _rule: string, message: string) => reports.push(message),
  });
  for (const declaration of source.statements) {
    assert.ok(ts.isClassDeclaration(declaration));
    const [method] = declaration.members;
    assert.ok(ts.isMethodDeclaration(method) && method.body);
    const [statement] = method.body.statements;
    assert.ok(ts.isReturnStatement(statement) && statement.expression && ts.isCallExpression(statement.expression));
    check(statement.expression, queryContext);
  }
  assert.equal(readCount, fileLimit);
  assert.deepEqual(visitedDirectories, [root, path.join(root, 'nested')]);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /AtLimitGuard/);
});
