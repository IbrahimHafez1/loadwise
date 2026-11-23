'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { applyChangesToText } = require('../../editor/apply-fix.cjs');
const { applyEdits, hunksFor, lineStartsOf, normalize } = require('../../lib/shared/fix-hunks.cjs');
const { introducedSyntaxError } = require('../../lib/shared/fix-safety.cjs');
const { labelledLines } = require('../../lib/shared/fix-terminal.cjs');
const {
  createWriteTracker,
  dropConflictingComments,
  formatUpdates,
  missingPrettierNote,
  rememberCommentRow,
  whyComment,
  withWhyComment,
  withoutWhyComment,
} = require('../../lib/shared/fix-presentation.cjs');

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
const loadwisePrettier = path.dirname(require.resolve('prettier/package.json'));
const ruleId = 'array-repeated-membership';
const comment =
  '// Loadwise array-repeated-membership: An array is tested with includes or\n// indexOf repeatedly where a Set would do.';
// The comment as inserted above a statement indented by two spaces.
const indentedComment = comment.replace(/^/gm, '  ');
const hunkJoinDistance = 3;

function entryFor(text, filename = 'site.ts') {
  return {
    filename,
    absolute: path.resolve(filename),
    text,
    lineStarts: lineStartsOf(text),
    sourceFile: ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    scriptKind: ts.ScriptKind.TS,
  };
}

// Replaces the first `find` after `after` with `replace`.
function replaceEdit(text, find, replace, after = '') {
  const start = text.indexOf(find, after ? text.indexOf(after) : 0);
  return { start, end: start + find.length, text: replace };
}

// The text after the fix, with or without its why-comment, for an edit at the finding.
function commented(text, edit, findingText = text.slice(edit.start, edit.end)) {
  const entry = entryFor(text);
  const result = withWhyComment({ ruleId, entry, edits: [edit], findingOffset: text.indexOf(findingText) });
  return { ...result, text: applyEdits(text, result.edits) };
}

// Builds a fix the way the site-fix modules do.
function buildFix(entry, edits, findingOffset) {
  const result = withWhyComment({ ruleId, entry, edits, findingOffset });
  const changes = hunksFor(entry, result.edits, hunkJoinDistance).map((hunk) => ({
    ...hunk,
    before: normalize(hunk.before),
    after: normalize(hunk.after),
  }));
  const fix = { changes };
  if (result.comment) rememberCommentRow(fix, entry.filename, result.row);
  return fix;
}

function temporaryDirectory(context, prefix) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, prefix));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// Gives the project a `node_modules/prettier` that loads Loadwise's own copy.
function installPrettier(directory) {
  const folder = path.join(directory, 'node_modules', 'prettier');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'package.json'), '{"name":"prettier","main":"index.js"}');
  fs.writeFileSync(path.join(folder, 'index.js'), `module.exports = require(${JSON.stringify(loadwisePrettier)});`);
}

// Runs `action` and returns what it printed to stderr.
function capturingErrors(action) {
  const savedError = console.error;
  const errors = [];
  console.error = (message) => errors.push(message);
  try {
    return { result: action(), errors };
  } finally {
    console.error = savedError;
  }
}

test('the why-comment is the rule description, cut to its first sentence', () => {
  assert.equal(whyComment(ruleId), comment);
  assert.equal(whyComment('not-a-rule'), undefined);
});

test('the why-comment wraps at 80 columns, and removing it keeps a project comment matching one of its lines', () => {
  for (const line of comment.split('\n')) assert.ok(line.length <= 80, line);
  const before = '  // indexOf repeatedly where a Set would do.\n  const hit = ids.includes(1);';
  const after = indentedComment + '\n  // indexOf repeatedly where a Set would do.\n  const hit = new Set(ids).has(1);';
  const fix = { changes: [{ file: 'site.ts', line: 1, before, after }] };
  assert.equal(
    withoutWhyComment(fix, ruleId).changes[0].after,
    '  // indexOf repeatedly where a Set would do.\n  const hit = new Set(ids).has(1);',
  );
});

test('a long note wraps under its label', () => {
  const note = 'word '.repeat(40).trim();
  const lines = labelledLines('Note', note);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => line.length <= 100));
  assert.ok(lines[0].startsWith('  Note: word'));
  assert.ok(lines.slice(1).every((line) => line.startsWith(' '.repeat('  Note: '.length) + 'word')));
  assert.deepEqual(lines.join(' ').split(/\s+/).filter(Boolean), ['Note:', ...note.split(' ')]);
});

// Identifiers in TypeScript code, read with the scanner so strings and comments are left out.
function identifiersOf(code) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, code);
  const names = new Set();
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.Identifier) names.add(scanner.getTokenText());
  }
  return names;
}

test('the why-comment names no identifier of the rule example that the fixed file lacks', () => {
  const scan = spawnSync(process.execPath, [bin, 'perf', 'examples/slow.ts', '--json'], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8',
  });
  const membership = JSON.parse(scan.stdout).findings.find((finding) => finding.ruleId === ruleId);
  const original = fs.readFileSync(path.resolve(__dirname, '../../examples/slow.ts'), 'utf8');
  const fixedNames = identifiersOf([original, ...membership.fix.changes.map((change) => change.after)].join('\n'));
  const { code } = require('../../editor/performance-examples.cjs').exampleFor(ruleId, 'typescript', '');
  const exampleOnly = [...identifiersOf(code)].filter((name) => !fixedNames.has(name));
  assert.ok(exampleOnly.includes('allowedIds'), 'the example names a variable the file does not have');
  const fixComment = membership.fix.changes
    .flatMap((change) => change.after.split('\n').filter((line) => line.trim().startsWith('//')))
    .map((line) => line.trim())
    .join('\n');
  assert.equal(fixComment, comment);
  const words = new Set(fixComment.match(/[A-Za-z_$][\w$]*/g));
  assert.deepEqual(
    exampleOnly.filter((name) => words.has(name)),
    [],
  );
});

test('the why-comment goes on its own line above the statement holding the fixed site', () => {
  const text = ['function find(ids: number[]) {', '  const hit = ids.includes(1);', '  return hit;', '}', ''].join(
    '\n',
  );
  const result = commented(text, replaceEdit(text, 'ids.includes(1)', 'new Set(ids).has(1)'));
  assert.equal(
    result.text,
    [
      'function find(ids: number[]) {',
      indentedComment,
      '  const hit = new Set(ids).has(1);',
      '  return hit;',
      '}',
      '',
    ].join('\n'),
  );
});

test('a decorated member takes the why-comment above its decorators', () => {
  const text = ['class Controller {', '  @Get()', '  find(id: string) {}', '}', ''].join('\n');
  const result = commented(text, replaceEdit(text, 'id: string', '{ id }: { id: string }'));
  assert.equal(
    result.text,
    ['class Controller {', indentedComment, '  @Get()', '  find({ id }: { id: string }) {}', '}', ''].join('\n'),
  );
});

test('no why-comment inside a template, after code on the same line, or in a catch block', () => {
  const template = ['const html = `${[1].map((value) => {', '  return value;', '})}`;', ''].join('\n');
  const inTemplate = commented(template, replaceEdit(template, 'value;', 'value + 1;'));
  assert.equal(inTemplate.comment, undefined);
  assert.doesNotMatch(inTemplate.text, /Loadwise/);
  const sameLine = 'if (ready) { run(ids.includes(1)); }\n';
  assert.equal(commented(sameLine, replaceEdit(sameLine, 'ids.includes(1)', 'set.has(1)')).comment, undefined);
  const inCatch = 'try {\n  load();\n} catch {\n  report(ids.includes(1));\n}\n';
  assert.equal(commented(inCatch, replaceEdit(inCatch, 'ids.includes(1)', 'set.has(1)')).comment, undefined);
});

test('the why-comment is added once, and a review directive or JSDoc above the statement stays attached', () => {
  const already = ['function find(ids: number[]) {', indentedComment, '  const hit = ids.includes(1);', '}', ''].join(
    '\n',
  );
  const repeated = commented(already, replaceEdit(already, 'ids.includes(1)', 'set.has(1)'));
  assert.equal(repeated.comment, undefined);
  assert.equal(repeated.text.split(indentedComment).length, 2);
  const reviewed = [
    'function find(ids: number[]) {',
    '  // loadwise-reviewed other-rule -- checked',
    '  /** The hit. */',
    '  const hit = ids.includes(1);',
    '}',
    '',
  ].join('\n');
  assert.equal(
    commented(reviewed, replaceEdit(reviewed, 'ids.includes(1)', 'set.has(1)')).text,
    [
      'function find(ids: number[]) {',
      indentedComment,
      '  // loadwise-reviewed other-rule -- checked',
      '  /** The hit. */',
      '  const hit = set.has(1);',
      '}',
      '',
    ].join('\n'),
  );
  // The comment is not a review directive, so a rescan still reports the site.
  assert.doesNotMatch(comment, /^\/\/\s+(?:loadwise|warden|maintainability|backend-perf)-reviewed\b/);
});

test('code inserted at the statement, such as a helper, takes the why-comment above it', () => {
  const text = ['const hit = ids.includes(1);', ''].join('\n');
  const helper = 'const set = new Set(ids);\n';
  const result = withWhyComment({
    ruleId,
    entry: entryFor(text),
    edits: [{ start: 0, end: 0, text: helper }, replaceEdit(text, 'ids.includes(1)', 'set.has(1)')],
    findingOffset: text.indexOf('ids'),
  });
  assert.equal(applyEdits(text, result.edits), comment + '\n' + helper + 'const hit = set.has(1);\n');
});

test('two fixes anchored on one statement share a single why-comment and apply together', () => {
  const text = [
    'function find(ids: number[]) {',
    '  const hit =',
    '    ids.includes(1) ||',
    '    ids.includes(2);',
    '}',
    '',
  ].join('\n');
  const entry = entryFor(text);
  const findings = [1, 2].map((value) => {
    const edit = replaceEdit(text, `ids.includes(${value})`, `set.has(${value})`);
    return { ruleId, fix: buildFix(entry, [edit], edit.start) };
  });
  assert.ok(findings.every((finding) => finding.fix.changes.some((change) => change.after.includes(indentedComment))));
  dropConflictingComments(findings);
  // Both keep the same comment-only change, so applying them together writes the comment once.
  const commentChanges = findings.map((finding) =>
    JSON.stringify(finding.fix.changes.filter((change) => change.after.includes(indentedComment))),
  );
  assert.equal(commentChanges[0], commentChanges[1]);
  // `loadwise fix` writes a change shared by several fixes once.
  const shared = new Map(
    findings.flatMap((finding) => finding.fix.changes).map((change) => [JSON.stringify(change), change]),
  );
  const applied = applyChangesToText(text, [...shared.values()], { exactLocation: true });
  assert.equal(
    applied.text,
    [
      'function find(ids: number[]) {',
      indentedComment,
      '  const hit =',
      '    set.has(1) ||',
      '    set.has(2);',
      '}',
      '',
    ].join('\n'),
  );
});

test('--no-comments gives exactly the hunks built without the comment', () => {
  const text = [
    'function find(ids: number[]) {',
    '  const hit = check(',
    '    a,',
    '    ids.includes(1),',
    '  );',
    '}',
    '',
  ].join('\n');
  const entry = entryFor(text);
  const edit = replaceEdit(text, 'ids.includes(1)', 'set.has(1)');
  const withComment = buildFix(entry, [edit], edit.start);
  assert.equal(withComment.changes.length, 2, 'the comment row is outside the code hunk');
  const plain = hunksFor(entry, [edit], hunkJoinDistance).map((hunk) => ({ ...hunk, after: normalize(hunk.after) }));
  assert.deepEqual(withoutWhyComment(withComment, ruleId).changes, plain);
});

test('--no-comments and --no-format are refused without a fix run', (context) => {
  const directory = temporaryDirectory(context, 'loadwise-presentation-flags-');
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: directory, encoding: 'utf8' });
  for (const args of [
    ['perf', '--no-comments'],
    ['sec', '--no-format'],
    ['maint', '.', '--no-comments'],
    ['fix', '--handoff', '--no-format'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 2, args.join(' ') + result.stdout);
    assert.match(result.stderr, /--no-comments and --no-format/);
  }
});

const unformatted = [
  'const   untouched = {a:1};',
  'function run() {',
  '  const value = 1;',
  '  const   alsoUntouched=2;',
  '}',
  '',
].join('\n');
const applied = unformatted.replace(
  'const value = 1;',
  '// Loadwise note\n  const value = someLongFunctionName(argumentNumberOne, argumentNumberTwo, argumentNumberThree, four);',
);

function formatApplied(context, prettier) {
  const directory = temporaryDirectory(context, 'loadwise-format-');
  if (prettier) installPrettier(directory);
  const file = path.join(directory, 'run.ts');
  return {
    file,
    formatted: formatUpdates(path.dirname(file), [
      { file, before: unformatted, after: applied, hunks: [{ key: 'value', row: 2, removed: 1, added: 2 }] },
    ]),
  };
}

test('Prettier formats only the changed lines and the reported hunk shows the formatted text', (context) => {
  const { result, errors } = capturingErrors(() => formatApplied(context, true));
  const text = result.formatted.texts.get(result.file);
  assert.deepEqual(errors, []);
  const lines = text.split('\n');
  assert.equal(lines[0], 'const   untouched = {a:1};');
  assert.ok(lines.includes('  const   alsoUntouched=2;'));
  assert.match(text, /const value = someLongFunctionName\(\n {4}argumentNumberOne,\n/);
  const hunk = result.formatted.hunks.get('value');
  assert.equal(hunk.line, 3);
  assert.equal(hunk.before, '  const value = 1;');
  assert.equal(
    text
      .split('\n')
      .slice(2, 2 + hunk.after.split('\n').length)
      .join('\n'),
    hunk.after,
  );
});

test('without Prettier in the project the applied text stays as written, with one note', (context) => {
  const { result, errors } = capturingErrors(() => formatApplied(context, false));
  assert.equal(result.formatted.texts.size, 0);
  assert.deepEqual(errors, [missingPrettierNote]);
});

test('a later fix from the same scan moves past the rows an earlier write added', () => {
  const tracker = createWriteTracker();
  const file = path.resolve('tracked.ts');
  tracker.recordWrites([{ file, line: 2, before: 'a', after: 'comment\na' }]);
  const fix = { changes: [{ file: 'tracked.ts', line: 5, before: 'b', after: 'c' }] };
  assert.equal(tracker.rebase(fix, (name) => path.resolve(name)).changes[0].line, 6);
  assert.equal(tracker.rebase({ changes: [{ ...fix.changes[0], line: 1 }] }, path.resolve).changes[0].line, 1);
});

test('the per-checker --fix records the text formatting left for each written change', (context) => {
  const directory = temporaryDirectory(context, 'loadwise-tracked-');
  installPrettier(directory);
  const file = path.join(directory, 'run.ts');
  fs.writeFileSync(file, applied);
  const recorded = {
    file: 'run.ts',
    line: 3,
    before: '  const value = 1;',
    after: applied.split('\n').slice(2, 4).join('\n'),
  };
  const tracker = createWriteTracker();
  tracker.recordWrites([{ ...recorded, file, owner: recorded }]);
  tracker.format(directory);
  const rows = fs.readFileSync(file, 'utf8').split('\n');
  assert.match(recorded.after, /^ {2}\/\/ Loadwise note\n {2}const value = someLongFunctionName\(\n/);
  assert.equal(rows.slice(2, 2 + recorded.after.split('\n').length).join('\n'), recorded.after);
  assert.equal(rows[0], 'const   untouched = {a:1};');
  assert.ok(rows.includes('  const   alsoUntouched=2;'), 'a statement next to the change is unchanged');
});

test('loadwise fix comments and formats each applied fix by default; --no-comments and --no-format leave both out', (context) => {
  const example = fs.readFileSync(path.resolve(__dirname, '../../examples/slow.ts'), 'utf8');
  const directory = temporaryDirectory(context, 'loadwise-presentation-');
  const write = () => {
    fs.writeFileSync(path.join(directory, 'package.json'), '{}');
    fs.writeFileSync(path.join(directory, 'tsconfig.json'), '{"files":["slow.ts"]}');
    fs.writeFileSync(path.join(directory, 'slow.ts'), example);
  };
  const run = (...args) =>
    spawnSync(process.execPath, [bin, ...args], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, LOADWISE_AGENT: '0' },
    });
  write();
  installPrettier(directory);
  const fixed = run('fix', '--yes', 'performance', '--json');
  assert.equal(fixed.status, 0, fixed.stderr);
  const source = fs.readFileSync(path.join(directory, 'slow.ts'), 'utf8');
  assert.ok(source.includes(indentedComment + '\n'));
  const membership = JSON.parse(fixed.stdout).applied.find((finding) => finding.ruleId === ruleId);
  const [change] = membership.fix.changes;
  assert.ok(change.after.startsWith(indentedComment + '\n'));
  assert.ok(source.includes(change.after), 'the reported hunk is the formatted text');
  assert.match(change.after, /orders\.filter\(\(order\) =>/, 'Prettier formatted the changed lines');
  assert.ok(source.includes(example.split('\n').at(-2)), 'an untouched line is unchanged');
  const rescan = run('perf', '--json');
  assert.ok(!JSON.parse(rescan.stdout).findings.some((finding) => finding.ruleId === ruleId));
  write();
  const plain = run('fix', '--yes', 'performance', '--no-comments', '--no-format');
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(
    plain.stdout,
    /^Fixed: perf slow\.ts:\d+ \[array-repeated-membership #\w+\]\n {2}Why: An array is tested with includes or indexOf repeatedly where a Set would do\.\n/m,
    'each applied fix says why it changed the code',
  );
  const plainSource = fs.readFileSync(path.join(directory, 'slow.ts'), 'utf8');
  assert.doesNotMatch(plainSource, /Loadwise/);
  assert.match(plainSource, /orders\.filter\(order =>/);
});

test('a call Prettier collapses onto one line keeps a single closing parenthesis', (context) => {
  const directory = temporaryDirectory(context, 'loadwise-collapse-');
  installPrettier(directory);
  fs.writeFileSync(path.join(directory, '.prettierrc'), '{"singleQuote":true,"printWidth":120}');
  const file = path.join(directory, 'controller.ts');
  const before = [
    'export class LocationsController {',
    '  update(id: number, dto: object, request: object, user: { id: number }) {',
    '    return this.locationsService.update(',
    '      id,',
    '      dto,',
    '      this.detectLanguage(request),',
    '      user.id,',
    '    );',
    '  }',
    '}',
    '',
  ].join('\n');
  const after = before.replace('this.detectLanguage(request)', 'detectLanguage(request)');
  const { result } = capturingErrors(() =>
    formatUpdates(directory, [{ file, before, after, hunks: [{ key: 'call', row: 5, removed: 1, added: 1 }] }]),
  );
  const text = result.texts.get(file) ?? after;
  assert.equal(introducedSyntaxError(file, before, text), undefined, text);
  assert.equal(text.match(/\);/g).length, 1, text);
});

test('loadwise fix says why once for fixes of the same rule and keeps each fix note under its site', (context) => {
  const example = fs.readFileSync(path.resolve(__dirname, '../../examples/slow.ts'), 'utf8');
  const directory = temporaryDirectory(context, 'loadwise-grouped-');
  fs.writeFileSync(path.join(directory, 'package.json'), '{}');
  fs.writeFileSync(path.join(directory, 'tsconfig.json'), '{"files":["slow.ts"]}');
  fs.writeFileSync(
    path.join(directory, 'slow.ts'),
    example +
      '\nexport function blockedOrders(orders: Order[], request: { body: { blocked: number[] } }) {\n' +
      '  const blocked = request.body.blocked;\n' +
      '  return orders.filter(order => blocked.includes(order.customerId));\n}\n',
  );
  const result = spawnSync(process.execPath, [bin, 'fix', '--yes', 'performance', '--no-format'], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, LOADWISE_AGENT: '0' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^Fixed 2 \[array-repeated-membership\]:\n {2}Why: An array is tested .*\n {2}perf slow\.ts:6 #\w+\n {4}Note: .*`allowed`[^]*\n {2}perf slow\.ts:14 #\w+\n {4}Note: .*`blocked`/m,
  );
  assert.equal(result.stdout.match(/Why: An array is tested/g).length, 1);
});
