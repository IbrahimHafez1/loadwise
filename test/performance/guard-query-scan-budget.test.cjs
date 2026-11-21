'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { check } = require('../../lib/performance/guard-queries.cjs');

test('guard registration discovery stops at the file budget within a directory', (context) => {
  const fileLimit = 20_000;
  const root = path.join(__dirname, 'virtual-guard-budget');
  const file = (name) => ({ name, isDirectory: () => false });
  const directory = (name) => ({ name, isDirectory: () => true });
  const visitedDirectories = [];
  let readCount = 0;
  context.mock.method(fs, 'existsSync', (filename) => filename === path.join(root, 'package.json'));
  context.mock.method(fs, 'readdirSync', (filename) => {
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
  context.mock.method(fs, 'readFileSync', (filename) => {
    readCount++;
    if (filename.endsWith('unreadable.ts')) throw new Error('unreadable');
    if (filename.endsWith('at-limit.ts')) return 'app.useGlobalGuards(AtLimitGuard);';
    if (filename.endsWith('over-budget.ts')) return 'app.useGlobalGuards(OverBudgetGuard);';
    return '';
  });
  const guard = (name) => `class ${name} implements CanActivate { canActivate() { return pool.query("select 1"); } }`;
  const source = ts.createSourceFile(
    path.join(root, 'guard.ts'),
    guard('AtLimitGuard') + '\n' + guard('OverBudgetGuard'),
    ts.ScriptTarget.Latest,
    true,
  );
  const reports = [];
  const queryContext = {
    checker: { getSymbolAtLocation: () => undefined },
    isPackageType: () => true,
    report: (_node, _rule, message) => reports.push(message),
  };
  for (const declaration of source.statements)
    check(declaration.members[0].body.statements[0].expression, queryContext);
  assert.equal(readCount, fileLimit);
  assert.deepEqual(visitedDirectories, [root, path.join(root, 'nested')]);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /AtLimitGuard/);
});
