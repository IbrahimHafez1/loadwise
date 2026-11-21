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
  assert.match(result.stdout, /^ {2}fix: {5}npx loadwise maint --staged --fix --only [0-9a-f]+$/m);
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

test('printed fix commands retain the scan directory, custom config and changed range', (context) => {
  const root = tempRepo(context);
  const directory = 'service api';
  fs.mkdirSync(path.join(root, directory));
  fs.writeFileSync(path.join(root, directory, 'app.js'), deepFunction + '\n');
  fs.writeFileSync(path.join(root, 'scan config.json'), '{}');
  git(root, 'add', directory);
  const inputs = [directory, '--loadwise-config', 'scan config.json'];
  const scoped = run(root, ...inputs, '--changed-since', 'HEAD');
  assert.equal(scoped.status, 1, scoped.stderr);
  const fix = scoped.stdout.match(
    /^ {2}fix: {5}npx loadwise maint 'service api' --loadwise-config 'scan config\.json' --changed-since HEAD --fix --only ([0-9a-f]+)$/m,
  );
  assert.ok(fix, scoped.stdout);
  assert.match(
    run(root, ...inputs).stdout,
    /^Fix all: npx loadwise maint 'service api' --loadwise-config 'scan config\.json' --fix --only /m,
  );
  const applied = run(root, ...inputs, '--changed-since', 'HEAD', '--fix', '--only', fix[1], '--json');
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(JSON.parse(applied.stdout).applied, [fix[1]]);
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
  const empty = run(root, '--staged', '--json');
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout), {
    mode: 'source',
    scannedFiles: 0,
    findings: [],
    contractFindingCount: 0,
  });
  const sarif = run(root, '--staged', '--format', 'sarif');
  assert.equal(sarif.status, 0, sarif.stderr);
  assert.deepEqual(JSON.parse(sarif.stdout).runs[0].results, []);
  assert.equal(run(root, '--staged', '--fix', '--only', 'missing').status, 2);
});

test('a newly added file counts every line as changed', (context) => {
  const root = tempRepo(context);
  fs.writeFileSync(path.join(root, 'added.js'), deepFunction.replace('label', 'other') + '\n');
  const untracked = run(root, '--changed-since', 'HEAD', '--json');
  assert.equal(untracked.status, 1, untracked.stderr);
  assert.ok(JSON.parse(untracked.stdout).findings.some((finding) => finding.file === 'added.js'));
  assert.equal(run(root, '--staged', '.').stdout, '');
  git(root, 'add', 'added.js');
  const result = run(root, '--staged', '.');
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^added\.js:/m);
  assert.doesNotMatch(result.stdout, /^app\.js:/m);
});

test('changed mode scans a staged Python file and skips unchanged and ignored sources', (context) => {
  try {
    if (!require('@ast-grep/cli/postinstall.js').resolveBinaryPath())
      return context.skip('Optional parser unavailable');
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') return context.skip('Optional parser unavailable');
    throw error;
  }
  const root = tempRepo(context);
  const nested = [
    'def run(ok):',
    '    if ok:',
    '        if ok:',
    '            if ok:',
    '                if ok:',
    '                    pass',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'loadwise.config.json'), '{"ignore":["ignored.py"]}');
  fs.writeFileSync(path.join(root, 'ignored.py'), 'def @@@:\n');
  fs.writeFileSync(path.join(root, 'changed.py'), nested);
  git(root, 'add', 'changed.py', 'ignored.py');
  for (const flags of [['--staged'], ['--changed-since', 'HEAD']]) {
    const result = run(root, ...flags, '--json');
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.scannedFiles, 1);
    assert.equal(report.dependencyFiles, 0);
    assert.deepEqual(
      report.findings.map(({ file, line, ruleId }) => [file, line, ruleId]),
      [['changed.py', 5, 'deep-control-flow']],
    );
  }
  assert.doesNotMatch(run(root, '--staged').stdout, /dismiss:/);
  fs.writeFileSync(path.join(root, 'changed.py'), 'def @@@:\n');
  const invalid = run(root, '--changed-since', 'HEAD', '--json');
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /changed\.py/);
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

test('workspace counts describe the selected files in both full and changed scans', (context) => {
  const root = tempRepo(context);
  fs.writeFileSync(path.join(root, 'package.json'), '{"workspaces":["packages/*"]}');
  const folder = path.join(root, 'packages', 'api');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'package.json'), '{"name":"api"}');
  fs.writeFileSync(path.join(folder, 'index.ts'), 'export function start() {}\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'workspace');
  fs.writeFileSync(path.join(folder, 'helper.js'), 'module.exports = 1;\n');
  git(root, 'add', '.');
  for (const [flags, expected] of [
    [[], { JavaScript: 1, TypeScript: 1 }],
    [['--staged'], { JavaScript: 1 }],
  ]) {
    const result = run(root, '--workspace', 'api', '--json', ...flags);
    assert.ok(result.status === 0 || result.status === 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.languageCounts, expected);
    assert.equal(report.scannedFiles, Object.keys(expected).length);
    assert.equal(report.dependencyFiles, report.scannedFiles);
  }
});
