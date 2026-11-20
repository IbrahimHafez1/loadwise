'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { sourceExampleFor } = require('../source-example.cjs');

function issueFor(line) {
  const document = {
    languageId: 'typescript',
    isDirty: false,
    lineCount: 1,
    lineAt: () => ({ text: line }),
  };
  const diagnostic = {
    source: 'warden-backend',
    code: 'array-repeated-membership',
    range: { start: { line: 0, character: line.indexOf('.includes(') + 1 } },
  };
  return { document, diagnostic };
}

test('membership hover keeps real identifiers, every and the negation in Simbel-shaped conditions', () => {
  for (const [checks, lookup, negate] of [
    ['required', 'held', ''],
    ['granted', 'actorPermissions', '!'],
  ]) {
    const line = `return ${negate}${checks}.every((key) => ${lookup}.includes(key));`;
    const { document, diagnostic } = issueFor(line);
    const sample = sourceExampleFor(document, diagnostic);
    assert.ok(sample.code.includes(`new globalThis.Set(${lookup})`));
    assert.ok(sample.code.includes(`return ${negate}${checks}.every((key) => ${lookup}Set.has(key));`));
    const run = (body) =>
      vm.runInNewContext(`(function (${checks}, ${lookup}, enabled) {
      if (enabled) ${body}
      return 'skipped';
    })`);
    const before = run(line);
    const after = run(sample.code);
    for (const requested of [[], ['read'], ['read', 'write'], [NaN]]) {
      for (const enabled of [true, false]) {
        assert.equal(after(requested, ['read', NaN], enabled), before(requested, ['read', NaN], enabled));
      }
    }
  }
});

test('simple some with an unparenthesized parameter preserves its quantifier', () => {
  const { document, diagnostic } = issueFor('  return selected.some(key => visible.includes(key));');
  document.languageId = 'javascriptreact';
  const sample = sourceExampleFor(document, diagnostic);
  assert.equal(sample.language, 'javascript');
  assert.match(sample.code, /return selected\.some\(\(key\) => visibleSet\.has\(key\)\)/);
});

test('a property-membership rewrite constructs its set only on the fallback side of an OR', () => {
  const lines = [
    'const escalates =',
    '  permissions.includes(WILDCARD) ||',
    '  !permissions.every((key) => actor.permissions.includes(key));',
  ];
  const { document, diagnostic } = issueFor(lines[2]);
  document.lineCount = lines.length;
  document.lineAt = (index) => ({ text: lines[index] });
  diagnostic.range.start.line = 2;
  const result = sourceExampleFor(document, diagnostic);
  assert.equal(result.before, lines.join('\n'));
  assert.match(
    result.code,
    /if \(!escalates && permissions.length > 0\) \{\n  const permissionsSet = new globalThis.Set\(actor.permissions\)/,
  );
  const evaluate = (body, permissions, held) =>
    vm.runInNewContext(`${body}\nescalates;`, { actor: { permissions: held }, permissions, WILDCARD: '*' });
  for (const [permissions, held] of [
    [['*'], null],
    [['write'], ['read']],
    [[], []],
    [['read'], ['read', 'write']],
  ]) {
    assert.equal(evaluate(result.code, permissions, held), evaluate(result.before, permissions, held));
  }
  lines[1] = '  permissions.includes(WILDCARD) &&';
  assert.equal(sourceExampleFor(document, diagnostic), undefined);
});

test('unrecognized shape, scope collision, copied sets and stale or unrelated findings fall back', () => {
  for (const line of [
    'return required.every((key) => held.includes(other));',
    'return required.every((key) => held.includes(key))',
    'return required.every((key) => held.includes(key)) && later();',
    'return required.every((key) => read().includes(key));',
    'return required.every((key) => key.includes(key));',
    'return required.every((key) => globalThis.includes(key));',
    'return heldSet.every((key) => held.includes(key));',
    'return required.every((heldSet) => held.includes(heldSet));',
  ]) {
    const { document, diagnostic } = issueFor(line);
    assert.equal(sourceExampleFor(document, diagnostic), undefined, line);
  }
  const { document, diagnostic } = issueFor('return required.every(key => held.includes(key));');
  for (const overrides of [
    { code: 'deep-control-flow' },
    { source: 'warden-maint' },
    { range: { start: { line: 0, character: 0 } } },
    { message: 'This array was copied from a Set and is searched repeatedly.' },
  ])
    assert.equal(sourceExampleFor(document, { ...diagnostic, ...overrides }), undefined);
  assert.equal(sourceExampleFor({ ...document, isDirty: true }, diagnostic), undefined);
  assert.equal(sourceExampleFor({ ...document, languageId: 'python' }, diagnostic), undefined);
});

function performanceSite(line, rule, anchor, message) {
  const { document, diagnostic } = issueFor(line);
  return sourceExampleFor(document, {
    ...diagnostic,
    code: rule,
    message,
    range: { start: { line: 0, character: line.indexOf(anchor) } },
  });
}

test('an existence rewrite changes only the diagnosed ORM call and preserves negation and scope filters', () => {
  for (const [before, after, filter] of [
    ['findOne', 'exists', '{ where: { id, clientId } }'],
    ['findOneBy', 'existsBy', '{ id, clientId }'],
  ]) {
    const line = `  if (!(await this.orgs.${before}(${filter}))) {`;
    const result = performanceSite(line, 'typeorm-existence-materialization', before);
    assert.equal(result.before, line.trim());
    assert.equal(result.code, line.trim().replace(before, after));
    assert.ok(result.inline.includes(`this.orgs.${before}(…) → this.orgs.${after}(…)`));
    assert.match(result.note, /load hooks/);
    assert.equal(performanceSite(line, 'typeorm-existence-materialization', 'orgs'), undefined);
    assert.equal(performanceSite(line, 'orm-query-in-loop', before), undefined);
  }
});

test('filesystem suggestions preserve call arguments, awaiting real Node methods in standalone contexts', () => {
  const write = "writeFileSync(join(dir, 'report.html'), html, 'utf8');";
  const result = performanceSite('    ' + write, 'node-sync-fs-in-async', 'writeFileSync', 'fs.writeFileSync blocks');
  assert.equal(result.code, 'await ' + write.replace('writeFileSync', 'writeFile'));
  assert.match(result.note, /Import writeFile from node:fs\/promises/);
  const read = "const contents = fs.readFileSync('a)(b', 'utf8');";
  assert.equal(
    performanceSite(read, 'node-sync-fs-in-async', 'fs.readFileSync', 'fs.readFileSync blocks').code,
    "const contents = await fs.promises.readFile('a)(b', 'utf8');",
  );
  for (const line of [
    'const value = fs.readFileSync(7);',
    "const value = fs.readFileSync(path).toString('utf8');",
    'return fs.readFileSync(path) + other();',
    'if (enabled) fs.readFileSync(path);',
  ]) {
    assert.equal(
      performanceSite(line, 'node-sync-fs-in-async', 'fs.readFileSync', 'fs.readFileSync blocks'),
      undefined,
    );
  }
  assert.equal(performanceSite(write, 'node-sync-fs-in-async', 'writeFileSync', 'fs.readFileSync blocks'), undefined);
});

test('multiline existence comparisons retain filter lines and stop at the close of the options', () => {
  const lines = ['  await repo.findOne({', '    where: { clientId, campaignId },', '  })', ') {'];
  const { document, diagnostic } = issueFor(lines[0]);
  document.lineCount = lines.length;
  document.lineAt = (index) => ({ text: lines[index] });
  diagnostic.code = 'typeorm-existence-materialization';
  diagnostic.range.start.character = lines[0].indexOf('findOne');
  const result = sourceExampleFor(document, diagnostic);
  assert.equal(result.before, 'await repo.findOne({\n  where: { clientId, campaignId },\n})');
  assert.equal(result.code, result.before.replace('findOne', 'exists'));
  lines[2] = '  // remaining lines are outside the snippet';
  assert.equal(sourceExampleFor(document, diagnostic).code, 'repo.exists(…)');
});
