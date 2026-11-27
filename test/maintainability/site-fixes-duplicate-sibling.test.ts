import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import ts from 'typescript';
import { applyFix } from '../../editor/apply-fix.cjs';
import { buildFix, createFileCache } from '../../lib/maintainability/site-fix.js';
import type { FixChange } from '../../lib/shared/types.js';

const helper = `// Handle an optional JSON field from a form.
function parseItems(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return value;
    }
  }
  return value;
}`;
const files = ['create.ts', 'update.ts'];
const template =
  "import { initialize } from './bootstrap';\n\n" +
  helper +
  '\n\ninitialize();\nexport const transform = (input: unknown) => parseItems(input);\n';

function fixture(context: TestContext, source = template) {
  const scratch = path.join(os.tmpdir(), 'AI-Work');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'loadwise-sibling-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sites = files.map((file) => {
    fs.writeFileSync(path.join(root, file), source);
    const line = source.split('\n').findIndex((row) => row.startsWith('function parseItems')) + 1;
    return { file, line, column: 10 };
  });
  const finding = { ...sites[0], ruleId: 'duplicate-implementation', message: 'duplicate', related: sites.slice(1) };
  return { root, build: () => buildFix(finding, createFileCache(root)) };
}

test('duplicate sibling modules share a closed helper without importing each other or executing another initializer', async (context) => {
  const { root, build } = fixture(context);
  const fix = build();
  assert.ok(fix);
  assert.equal(fix.requiresReview, true);
  const created = fix.changes.find((change: FixChange) => change.create);
  assert.ok(created);
  assert.equal(created.file, 'parse-items.ts');
  assert.match(created.after, /^\/\/ Handle an optional JSON field/);
  const result = applyFix(fix, {
    readFile: (file) => fs.readFileSync(path.join(root, file), 'utf8'),
    writeFile: (file, text: string) => fs.writeFileSync(path.join(root, file), text),
  });
  assert.equal(result.error, undefined);
  fs.writeFileSync(path.join(root, 'bootstrap.js'), 'exports.calls = 0; exports.initialize = () => exports.calls++;');
  for (const file of [...files, created.file]) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
    fs.writeFileSync(path.join(root, file.replace('.ts', '.js')), compiled.outputText);
  }
  const bootstrap: { default: { calls: number } } = await import(pathToFileURL(path.join(root, 'bootstrap.js')).href);
  for (const [index, file] of files.entries()) {
    const { transform }: { transform: (value: unknown) => unknown } = await import(
      pathToFileURL(path.join(root, file.replace('.ts', '.js'))).href
    );
    assert.equal(bootstrap.default.calls, index + 1);
    const existing = ['a'];
    assert.equal(transform(existing), existing);
    assert.deepEqual(transform('[1,2]'), [1, 2]);
    assert.deepEqual(transform('true'), [true]);
    assert.equal(transform('unparsed'), 'unparsed');
    assert.equal(transform(''), undefined);
  }
});

test('sibling extraction refuses captures, type dependencies, escaping identity, comments with directives and collisions', (context) => {
  for (const source of [
    template.replace('return value;\n}', 'return initialize(value);\n}'),
    template.replaceAll('value: unknown', 'value: FormValue') + '\ninterface FormValue { text: string }',
    template.replace('parseItems(input);', 'parseItems;'),
    template.replace('return value;\n}', 'return parseItems;\n}'),
    template.replace('// Handle', '// @ts-ignore Handle'),
    template.replace('\n}\n\ninitialize();', '\n} /* keep this */\n\ninitialize();'),
  ]) {
    assert.equal(fixture(context, source).build(), undefined);
  }
  const { root, build } = fixture(context);
  fs.writeFileSync(path.join(root, 'parse-items.js'), 'module.exports = {};');
  assert.equal(build(), undefined);
});
