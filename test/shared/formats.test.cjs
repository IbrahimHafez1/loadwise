'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { escapeData, escapeProperty, formatGithub } = require('../../lib/shared/formats/github.cjs');
const { formatSarif } = require('../../lib/shared/formats/sarif.cjs');
const { resolveFormat, renderReports } = require('../../lib/shared/formats/index.cjs');
const performanceRules = require('../../lib/performance/rule-ids.cjs');
const maintainabilityRules = require('../../lib/maintainability/rule-ids.cjs');

const { descriptionByRule } = performanceRules;

const cli = path.resolve(__dirname, '../../bin/loadwise.cjs');
const slowSource = fs.readFileSync(path.resolve(__dirname, '../../examples/slow.ts'), 'utf8');
const tsconfig = JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] });
const root = path.resolve('/repo/app');

const performanceReport = {
  findings: [
    { file: 'a.ts', line: 3, column: 5, ruleId: 'pg-query-in-loop', message: 'Slow. Detail.', id: 'aaa111' },
    { file: 'b.ts', line: 1, column: 1, ruleId: 'pg-transaction-on-pool', message: 'Contract broken.', id: 'bbb222' },
    {
      file: 'c.ts',
      line: 2,
      column: 2,
      ruleId: 'pg-query-in-loop',
      message: 'Test.',
      id: 'ccc333',
      contextualReason: 'test file',
    },
  ],
};
const maintainabilityReport = {
  findings: [
    {
      file: 'src/x.ts',
      line: 9,
      column: 1,
      ruleId: 'folder-boundary',
      message: 'Boundary.',
      id: 'ddd444',
      contextualReason: 'x',
    },
  ],
};
const entries = [
  { pillar: 'performance', root, report: performanceReport },
  { pillar: 'maintainability', root, report: maintainabilityReport },
  { pillar: 'security', root, report: null },
];

function project(context, files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-formats-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), text);
  return directory;
}

function loadwise(directory, ...args) {
  const run = spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8', windowsHide: true });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

test('every rule with an impact level has a one-line description', () => {
  for (const { impactByRule, descriptionByRule: descriptions } of [performanceRules, maintainabilityRules]) {
    assert.deepEqual(Object.keys(descriptions).sort(), Object.keys(impactByRule).sort());
    for (const text of Object.values(descriptions)) assert.match(text, /^[^\n]{10,140}\.$/);
  }
});

test('a rule without a registered description is summarized by the first sentence of its message', () => {
  const report = {
    findings: [{ file: 'a.ts', line: 1, column: 1, ruleId: 'unregistered-rule', message: 'One. Two.' }],
  };
  const sarif = JSON.parse(formatSarif([{ pillar: 'performance', root, report }]));
  assert.equal(sarif.runs[0].tool.driver.rules[0].shortDescription.text, 'One.');
});

test('SARIF registers every security rule and formats security findings at warning or note level', () => {
  const { securityRules } = require('../../lib/security/rule-ids.cjs');
  const { descriptionByRule: securityDescriptions } = require('../../lib/security/rule-descriptions.cjs');
  assert.deepEqual(Object.keys(securityDescriptions).sort(), [...securityRules].sort());
  const findings = securityRules.map((ruleId) => ({
    file: 'a.ts',
    ruleId,
    message: 'Finding details.',
  }));
  findings.push({ ...findings[0], contextualReason: 'reviewed' });
  const [run] = JSON.parse(formatSarif([{ pillar: 'security', root, report: { findings } }])).runs;
  for (const { id, shortDescription, helpUri } of run.tool.driver.rules) {
    assert.match(shortDescription.text, /^[^\n]{10,140}\.$/);
    assert.equal(shortDescription.text, securityDescriptions[id]);
    assert.equal(helpUri, `https://github.com/IbrahimHafez1/loadwise#${id}`);
  }
  assert.deepEqual(
    run.tool.driver.rules.map(({ id }) => id),
    securityRules,
  );
  assert.ok(run.results.slice(0, -1).every(({ level }) => level === 'warning'));
  assert.equal(run.results.at(-1).level, 'note');
});

test('github escaping follows the workflow command rules', () => {
  assert.equal(escapeData('100%\r\nnext: a,b'), '100%25%0D%0Anext: a,b');
  assert.equal(escapeProperty('a:b,c%\n'), 'a%3Ab%2Cc%25%0A');
});

test('github annotations use warning, error for contract findings and notice for contextual ones', () => {
  assert.deepEqual(formatGithub(entries).split('\n'), [
    '::warning file=a.ts,line=3,col=5,title=pg-query-in-loop::Slow. Detail.',
    '::error file=b.ts,line=1,col=1,title=pg-transaction-on-pool::Contract broken.',
    '::notice file=c.ts,line=2,col=2,title=pg-query-in-loop::Test.',
    '::error file=src/x.ts,line=9,col=1,title=folder-boundary::Boundary.',
  ]);
});

test('github annotations escape paths and messages', () => {
  const report = { findings: [{ file: 'we:ird,name.ts', line: 1, column: 1, ruleId: 'r', message: 'a\nb%' }] };
  assert.equal(
    formatGithub([{ pillar: 'performance', root, report }]),
    '::warning file=we%3Aird%2Cname.ts,line=1,col=1,title=r::a%0Ab%25',
  );
});

test('sarif has one run per reported pillar with rules, levels, locations and fingerprints', () => {
  const sarif = JSON.parse(formatSarif(entries));
  assert.equal(sarif.version, '2.1.0');
  assert.match(sarif.$schema, /sarif-2\.1\.0/);
  assert.equal(sarif.runs.length, 2);
  const [performance, maintainability] = sarif.runs;
  assert.equal(performance.tool.driver.name, 'loadwise');
  assert.deepEqual(
    performance.tool.driver.rules.map(({ id }) => id),
    ['pg-query-in-loop', 'pg-transaction-on-pool'],
  );
  assert.equal(performance.tool.driver.rules[0].helpUri, 'https://github.com/IbrahimHafez1/loadwise#pg-query-in-loop');
  assert.equal(performance.tool.driver.rules[0].shortDescription.text, descriptionByRule['pg-query-in-loop']);
  assert.deepEqual(
    performance.results.map(({ level }) => level),
    ['warning', 'error', 'note'],
  );
  assert.deepEqual(performance.results[0].partialFingerprints, { 'loadwise/findingId/v1': 'aaa111' });
  assert.deepEqual(performance.results[0].locations[0].physicalLocation.region, { startLine: 3, startColumn: 5 });
  assert.equal(performance.results[0].locations[0].physicalLocation.artifactLocation.uri, 'a.ts');
  assert.equal(maintainability.results[0].level, 'error');
});

test('sarif locations are relative to the repository root, not the scanned folder', (context) => {
  const repository = project(context, {});
  fs.mkdirSync(path.join(repository, '.git'));
  fs.mkdirSync(path.join(repository, 'services', 'api'), { recursive: true });
  const sarif = JSON.parse(
    formatSarif([{ pillar: 'performance', root: path.join(repository, 'services', 'api'), report: performanceReport }]),
  );
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, 'services/api/a.ts');
});

test('resolveFormat treats --json as --format json and rejects conflicts', () => {
  assert.equal(resolveFormat({}), 'text');
  assert.equal(resolveFormat({ json: true }), 'json');
  assert.equal(resolveFormat({ json: true, format: 'json' }), 'json');
  assert.equal(resolveFormat({ format: 'sarif' }), 'sarif');
  assert.throws(() => resolveFormat({ format: 'xml' }), /--format must be/);
  assert.throws(() => resolveFormat({ json: true, format: 'github' }), /cannot be combined/);
  assert.equal(typeof renderReports('github', []), 'string');
});

test('check --format sarif prints one run per checker and keeps the exit code', (context) => {
  const directory = project(context, { 'tsconfig.json': tsconfig, 'a.ts': slowSource });
  const run = loadwise(directory, 'check', '--format', 'sarif');
  assert.equal(run.code, 1, run.stderr);
  const sarif = JSON.parse(run.stdout);
  assert.deepEqual(
    sarif.runs.map((sarifRun) => sarifRun.automationDetails.id),
    ['loadwise/performance/', 'loadwise/maintainability/', 'loadwise/security/'],
  );
  assert.equal(sarif.runs[0].results.length, 3);
  for (const result of sarif.runs[0].results) {
    assert.ok(result.ruleId && result.message.text);
    assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, 'a.ts');
    assert.match(result.partialFingerprints['loadwise/findingId/v1'], /^[0-9a-f]+$/);
    assert.equal(result.properties.impact, 'medium');
  }
  for (const rule of sarif.runs[0].tool.driver.rules)
    assert.equal(rule.shortDescription.text, descriptionByRule[rule.id]);
});

test('check --format github prints annotations and check --format json matches --json', (context) => {
  const directory = project(context, { 'tsconfig.json': tsconfig, 'a.ts': slowSource });
  const github = loadwise(directory, 'check', '--format', 'github');
  assert.equal(github.code, 1, github.stderr);
  assert.equal(github.stdout.trim().split('\n').length, 3);
  assert.match(github.stdout, /^::warning file=a\.ts,line=\d+,col=\d+,title=[a-z-]+::/);
  assert.deepEqual(loadwise(directory, 'check', '--format', 'json'), loadwise(directory, 'check', '--json'));
});

test('perf and maint accept --format and exit as before', (context) => {
  const directory = project(context, { 'tsconfig.json': tsconfig, 'a.ts': slowSource });
  const perfGithub = loadwise(directory, 'perf', '--format', 'github');
  assert.equal(perfGithub.code, 1, perfGithub.stderr);
  assert.match(perfGithub.stdout, /^::warning file=a\.ts,/);
  const perfSarif = JSON.parse(loadwise(directory, 'perf', '--format', 'sarif').stdout);
  assert.equal(perfSarif.runs.length, 1);
  assert.equal(perfSarif.runs[0].results.length, 3);
  const maintSarif = loadwise(directory, 'maint', '--format', 'sarif');
  assert.equal(maintSarif.code, 0, maintSarif.stderr);
  assert.deepEqual(JSON.parse(maintSarif.stdout).runs[0].results, []);
  assert.equal(loadwise(directory, 'maint', '--format', 'github').stdout, '');
});

test('an unknown format or a conflict with --json exits 2', (context) => {
  const directory = project(context, { 'tsconfig.json': tsconfig, 'a.ts': slowSource });
  assert.equal(loadwise(directory, 'check', '--format', 'xml').code, 2);
  assert.equal(loadwise(directory, 'perf', '--json', '--format', 'sarif').code, 2);
  assert.equal(loadwise(directory, 'maint', '--json', '--format', 'github').code, 2);
});
