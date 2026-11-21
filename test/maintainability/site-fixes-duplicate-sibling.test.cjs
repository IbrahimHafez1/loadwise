'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { applyFix } = require('../../editor/apply-fix.cjs');
const { buildFix, createFileCache } = require('../../lib/maintainability/site-fix.cjs');

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

function fixture(context, source = template) {
  const scratch = path.join(os.tmpdir(), 'AI-Work');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'loadwise-sibling-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sites = files.map((file) => {
    fs.writeFileSync(path.join(root, file), source);
    const line = source.split('\n').findIndex((row) => row.startsWith('function parseItems')) + 1;
    return { file, line, column: 10 };
  });
  const finding = { ...sites[0], ruleId: 'duplicate-implementation', related: sites.slice(1) };
  return { root, build: () => buildFix(finding, createFileCache(root)) };
}

test('duplicate sibling modules share a closed helper without importing each other or executing another initializer', (context) => {
  const { root, build } = fixture(context);
  const fix = build();
  assert.equal(fix.requiresReview, true);
  const created = fix.changes.find((change) => change.create);
  assert.equal(created.file, 'shared-parse-items.ts');
  assert.match(created.after, /^\/\/ Handle an optional JSON field/);
  const result = applyFix(fix, {
    readFile: (file) => fs.readFileSync(path.join(root, file), 'utf8'),
    writeFile: (file, text) => fs.writeFileSync(path.join(root, file), text),
  });
  assert.equal(result.error, undefined);
  fs.writeFileSync(path.join(root, 'bootstrap.js'), 'exports.calls = 0; exports.initialize = () => exports.calls++;');
  for (const file of [...files, created.file]) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
    fs.writeFileSync(path.join(root, file.replace('.ts', '.js')), compiled.outputText);
  }
  const bootstrap = require(path.join(root, 'bootstrap.js'));
  for (const [index, file] of files.entries()) {
    const { transform } = require(path.join(root, file.replace('.ts', '.js')));
    assert.equal(bootstrap.calls, index + 1);
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
  fs.writeFileSync(path.join(root, 'shared-parse-items.js'), 'module.exports = {};');
  assert.equal(build(), undefined);
});
