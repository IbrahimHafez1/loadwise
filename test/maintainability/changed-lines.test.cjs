'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { parseChangedRanges, filterToChangedLines } = require('../../lib/maintainability/changed-lines.cjs');

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
const deepFunction = [
  'function label(values, mode) {',
  '  if (!values.length) {',
  '    return "none";',
  '  } else {',
  '    let text = "";',
  '    for (const value of values) {',
  '      if (mode === "loud") {',
  '        text += "?";',
  '        if (value > 0) text += "!";',
  '      }',
  '      text += ".";',
  '    }',
  '    return text;',
  '  }',
  '}',
  'function plain() {',
  '  return 1;',
  '}',
  'module.exports = { label, plain };',
].join('\n');

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function tempRepo(context) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'maintainability-changed-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'app.js'), deepFunction + '\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [bin, 'maint', ...args], { cwd: root, encoding: 'utf8' });
}

test('parses added files, modified ranges and renames, and ignores deletions', () => {
  const diff = [
    'diff --git a/new.js b/new.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.js',
    '@@ -0,0 +1,3 @@',
    '+a',
    'diff --git a/old.js b/renamed.js',
    'similarity index 90%',
    'rename from old.js',
    'rename to renamed.js',
    '--- a/old.js',
    '+++ b/renamed.js',
    '@@ -2 +2 @@',
    '--- looks like a header but is a removed line',
    '+x',
    '@@ -10,2 +10,0 @@',
    '-gone',
    '-gone',
    '@@ -20,0 +21,2 @@',
    '+y',
    '+z',
  ].join('\n');
  const changes = parseChangedRanges(diff);
  assert.deepEqual(changes.get('new.js'), [[1, Infinity]]);
  assert.deepEqual(changes.get('renamed.js'), [
    [2, 2],
    [21, 22],
  ]);
  assert.equal(changes.has('old.js'), false);
});

test('keeps a function finding when a change falls inside the function, not on its anchor line', () => {
  const functionFinding = { file: 'a.js', line: 9, rangeStartLine: 1, rangeEndLine: 15, ruleId: 'deep-control-flow' };
  const lineFinding = { file: 'a.js', line: 17, ruleId: 'query-mutates-state' };
  const findings = [functionFinding, lineFinding];
  assert.deepEqual(filterToChangedLines(findings, new Map([['a.js', [[3, 3]]]])), [functionFinding]);
  assert.deepEqual(filterToChangedLines(findings, new Map([['a.js', [[16, 18]]]])), [lineFinding]);
  assert.deepEqual(filterToChangedLines(findings, new Map([['a.js', [[40, 41]]]])), []);
  assert.deepEqual(filterToChangedLines(findings, new Map([['b.js', [[1, Infinity]]]])), []);
});

test('--staged reports a function finding for an edit inside it and exits 1', (context) => {
  const root = tempRepo(context);
  fs.writeFileSync(path.join(root, 'app.js'), deepFunction.replace('"none"', '"empty"') + '\n');
  git(root, 'add', 'app.js');
  const result = run(root, '--staged', '.');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^app\.js:\d+ \[deep-control-flow #[0-9a-f]+\]/m);
  assert.match(result.stdout, /^ {2}fix: {5}npx warden-maint --fix --only [0-9a-f]+$/m);
  assert.match(result.stdout, /^ {2}dismiss: \/\/ loadwise-reviewed deep-control-flow -- <reason>$/m);
  assert.match(result.stdout, /^1 new finding\(s\) in changed lines\. Apply fixes, then `git add`/m);
});

test('--staged ignores an edit outside the flagged function and prints nothing', (context) => {
  const root = tempRepo(context);
  fs.writeFileSync(path.join(root, 'app.js'), deepFunction.replace('return 1', 'return 2') + '\n');
  git(root, 'add', 'app.js');
  const result = run(root, '--staged', '.');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
});

test('--changed-since compares the working tree with a ref and supports --json', (context) => {
  const root = tempRepo(context);
  fs.writeFileSync(path.join(root, 'app.js'), deepFunction.replace('"none"', '"empty"') + '\n');
  const result = run(root, '--changed-since', 'HEAD', '--json', '.');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ['deep-control-flow'],
  );
  assert.equal(run(root, '--changed-since', '--bad', '.').status, 2);
});

test('the fast path returns before TypeScript loads', (context) => {
  const root = tempRepo(context);
  const guard = path.join(root, 'no-typescript.cjs');
  fs.writeFileSync(
    guard,
    [
      "const Module = require('node:module');",
      'const load = Module._load;',
      "Module._load = function (request, ...rest) { if (request === 'typescript') throw new Error('typescript loaded'); return load.call(this, request, ...rest); };",
    ].join('\n'),
  );
  const result = spawnSync(process.execPath, ['--require', guard, bin, 'maint', '--staged', '.'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('a newly added file counts every line as changed', (context) => {
  const root = tempRepo(context);
  fs.writeFileSync(path.join(root, 'added.js'), deepFunction.replace('label', 'other') + '\n');
  git(root, 'add', 'added.js');
  const result = run(root, '--staged', '.');
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^added\.js:/m);
  assert.doesNotMatch(result.stdout, /^app\.js:/m);
});

test('many changed files fall back to the full scan, which keeps cross-file rules', async (context) => {
  const root = tempRepo(context);
  fs.writeFileSync(path.join(root, 'one.js'), deepFunction + '\n');
  fs.writeFileSync(path.join(root, 'two.js'), deepFunction + '\n');
  const { loadPolicy } = require('../../lib/maintainability/project.cjs');
  const { scanChangedFiles } = require('../../lib/maintainability/scan-changed.cjs');
  const policy = loadPolicy(root);
  const files = ['one.js', 'two.js'];
  const perFile = await scanChangedFiles(root, policy, files, { parallelFrom: 3 });
  const fullScan = await scanChangedFiles(root, policy, files, { parallelFrom: 2 });
  assert.equal(perFile.scannedFiles, 2);
  assert.ok(!perFile.findings.some((finding) => finding.ruleId === 'duplicate-implementation'));
  assert.ok(fullScan.findings.some((finding) => finding.ruleId === 'duplicate-implementation'));
});
