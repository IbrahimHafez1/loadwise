import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '../..');
const defaultExport = 'default';

// Every list keyed by rule id that each new rule has to edit. Sorting them keeps parallel pull requests that add a
// rule from appending to the same tail and conflicting. Lists with a different key (the security `groups`) or with
// curated sections (fix-rationales.ts) are not here.
const sortedLists: Readonly<Record<string, readonly string[]>> = {
  'lib/accessibility/rule-ids.ts': ['knownRules', 'impactByRule', 'descriptionByRule'],
  'lib/maintainability/rule-ids.ts': ['knownRules', 'impactByRule', 'descriptionByRule'],
  'lib/performance/rule-ids.ts': ['sourceRules', 'indexRules', 'databaseRules', 'impactByRule', 'descriptionByRule'],
  'lib/reliability/rule-ids.ts': [
    'sourceRules',
    'migrationRules',
    'contractRules',
    'polyglotRules',
    'impactByRule',
    'descriptionByRule',
  ],
  'lib/security/rule-ids.ts': ['movedRuleInfo', 'phase5Rules', 'impactByRule', 'polyglotRules'],
  'lib/security/auth-crypto/rule-ids.ts': [defaultExport],
  'lib/security/deps/rule-ids.ts': [defaultExport],
  'lib/security/exposure/rule-ids.ts': [defaultExport],
  'lib/security/files/rule-ids.ts': [defaultExport],
  'lib/security/injection/rule-ids.ts': [defaultExport],
  'lib/security/request-forgery/rule-ids.ts': [defaultExport],
  'lib/security/rule-descriptions.ts': ['descriptionByRule'],
  'lib/security/examples/auth-crypto.cts': ['examples'],
  'lib/security/examples/deps.cts': ['examples'],
  'lib/security/examples/exposure.cts': ['examples'],
  'lib/security/examples/files.cts': ['examples'],
  'lib/security/examples/injection.cts': ['examples'],
  'lib/security/examples/moved.cts': ['examples'],
  'lib/security/examples/request-forgery.cts': ['examples'],
  'lib/editor/accessibility-examples.ts': ['examples'],
  'lib/editor/reliability-examples.ts': ['examples'],
  'lib/editor/security-examples.ts': ['phase5Examples'],
  'lib/editor/performance-examples.ts': ['examples', 'polyglot', 'mongooseIndexExamples'],
  'lib/editor/standalone-performance-examples.ts': ['standaloneExamples'],
  'lib/maintainability/examples.ts': ['examples'],
};

function listLiteralOf(expression: ts.Expression): ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | undefined {
  if (ts.isParenthesizedExpression(expression)) return listLiteralOf(expression.expression);
  if (ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression)) return expression;
  // new Set([...]): the rule ids are the array handed to the constructor.
  if (ts.isNewExpression(expression) && expression.arguments?.length) return listLiteralOf(expression.arguments[0]);
  return undefined;
}

function idOf(element: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(element)) return element.text;
  if (ts.isPropertyAssignment(element) && (ts.isStringLiteral(element.name) || ts.isIdentifier(element.name))) {
    return element.name.text;
  }
  return undefined;
}

function declaredLists(file: string): Map<string, string[]> {
  const sourceFile = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest);
  const lists = new Map<string, string[]>();
  const add = (name: string, expression: ts.Expression) => {
    const literal = listLiteralOf(expression);
    if (!literal) return;
    const elements = ts.isArrayLiteralExpression(literal) ? literal.elements : literal.properties;
    const ids = elements.map(idOf).filter((id) => id !== undefined);
    // A list built with a spread, such as the union of the groups, is not a keyed list.
    if (ids.length !== elements.length) return;
    lists.set(name, ids);
  };
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) add(defaultExport, statement.expression);
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer)
        add(declaration.name.text, declaration.initializer);
    }
  }
  return lists;
}

function firstOutOfOrderIndex(ids: readonly string[]): number {
  return ids.findIndex((id, index) => index > 0 && id < ids[index - 1]);
}

function assertSorted(label: string, ids: readonly string[]): void {
  const index = firstOutOfOrderIndex(ids);
  assert.equal(
    index,
    -1,
    `${label}: "${ids[index]}" is out of order after "${ids[index - 1]}"; keep the list sorted by rule id`,
  );
}

test('every registry list keyed by rule id is sorted', () => {
  for (const [file, names] of Object.entries(sortedLists)) {
    const lists = declaredLists(file);
    for (const name of names) {
      const ids = lists.get(name);
      assert.ok(ids, `${file}: no list named ${name}`);
      assertSorted(`${file} ${name}`, ids);
    }
  }
});

test('every security rule group is checked for order', () => {
  const securityDirectory = path.join(root, 'lib/security');
  const groupFiles = fs
    .readdirSync(securityDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(securityDirectory, entry.name, 'rule-ids.ts')))
    .map((entry) => `lib/security/${entry.name}/rule-ids.ts`);
  for (const file of groupFiles) assert.ok(Object.hasOwn(sortedLists, file), `${file} is not checked for order`);
});

test('the config schema lists rule ids in sorted order', () => {
  const schema: unknown = JSON.parse(fs.readFileSync(path.join(root, 'schema/loadwise.config.schema.json'), 'utf8'));
  const enums: string[][] = [];
  const collect = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    if ('propertyNames' in node && typeof node.propertyNames === 'object' && node.propertyNames !== null) {
      const names = 'enum' in node.propertyNames ? node.propertyNames.enum : undefined;
      if (Array.isArray(names)) enums.push(names.filter((name) => typeof name === 'string'));
    }
    for (const child of Object.values(node)) collect(child);
  };
  collect(schema);
  assert.equal(enums.length, 2);
  for (const names of enums) assertSorted('schema/loadwise.config.schema.json propertyNames.enum', names);
});

test('the order check names the first id that is out of place', () => {
  assert.throws(() => assertSorted('list', ['a', 'c', 'b', 'a']), /"b" is out of order after "c"/);
  assert.doesNotThrow(() => assertSorted('list', ['a', 'b', 'c']));
});
