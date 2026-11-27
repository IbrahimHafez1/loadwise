import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { escapeData, escapeProperty, formatGithub } from '../../lib/shared/formats/github.js';
import { formatSarif } from '../../lib/shared/formats/sarif.js';
import { resolveFormat, renderReports } from '../../lib/shared/formats/index.js';
import * as performanceRules from '../../lib/performance/rule-ids.js';
import * as reliabilityRules from '../../lib/reliability/rule-ids.js';
import * as maintainabilityRules from '../../lib/maintainability/rule-ids.js';
import type { Finding } from '../../lib/shared/types.js';
import type { FormatReport, ReportEntry } from '../../lib/shared/types/report-formats.js';
import type { SarifLog, SarifResult, SarifRule, SarifRun } from '../types/sarif.js';
import type { TestContext } from 'node:test';
import type { FileMap } from '../types/project-files.js';
import { securityRules, polyglotRules as securityPolyglotRules } from '../../lib/security/rule-ids.js';
import { descriptionByRule as securityDescriptions } from '../../lib/security/rule-descriptions.js';

const { descriptionByRule } = performanceRules;
const performanceDescriptions: Record<string, string> = descriptionByRule;

const cli = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const slowSource = fs.readFileSync(path.resolve(import.meta.dirname, '../../examples/slow.ts'), 'utf8');
const tsconfig = JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] });
const root = path.resolve('/repo/app');

const performanceReport: FormatReport = {
  findings: [
    { file: 'a.ts', line: 3, column: 5, ruleId: 'pg-query-in-loop', message: 'Slow. Detail.', id: 'aaa111' },
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
const reliabilityReport: FormatReport = {
  findings: [
    { file: 'b.ts', line: 1, column: 1, ruleId: 'pg-transaction-on-pool', message: 'Contract broken.', id: 'bbb222' },
  ],
};
const maintainabilityReport: FormatReport = {
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
const entries: ReportEntry[] = [
  { pillar: 'performance', root, report: performanceReport },
  { pillar: 'reliability', root, report: reliabilityReport },
  { pillar: 'maintainability', root, report: maintainabilityReport },
  { pillar: 'security', root, report: null },
];

function project(context: TestContext, files: FileMap) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-formats-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), text);
  return directory;
}

function loadwise(directory: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8', windowsHide: true });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

test('every rule with an impact level has a one-line description', () => {
  for (const { impactByRule, descriptionByRule: descriptions } of [
    performanceRules,
    reliabilityRules,
    maintainabilityRules,
  ]) {
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
  const describedRules = [...securityRules, ...securityPolyglotRules];
  assert.deepEqual(Object.keys(securityDescriptions).sort(), [...describedRules].sort());
  const findings = describedRules.map((ruleId): Finding => ({
    file: 'a.ts',
    ruleId,
    message: 'Finding details.',
  }));
  findings.push({ ...findings[0], contextualReason: 'reviewed' });
  const [run]: SarifRun[] = JSON.parse(formatSarif([{ pillar: 'security', root, report: { findings } }])).runs;
  const descriptionBySecurityRule: Record<string, string> = securityDescriptions;
  for (const { id, shortDescription, helpUri } of run.tool.driver.rules) {
    assert.match(shortDescription.text, /^[^\n]{10,140}\.$/);
    assert.equal(shortDescription.text, descriptionBySecurityRule[id]);
    assert.equal(helpUri, `https://github.com/IbrahimHafez1/loadwise#${id}`);
  }
  assert.deepEqual(
    run.tool.driver.rules.map(({ id }: SarifRule) => id),
    describedRules,
  );
  assert.ok(run.results.slice(0, -1).every(({ level }) => level === 'warning'));
  assert.equal(run.results.at(-1)?.level, 'note');
});

test('github escaping follows the workflow command rules', () => {
  assert.equal(escapeData('100%\r\nnext: a,b'), '100%25%0D%0Anext: a,b');
  assert.equal(escapeProperty('a:b,c%\n'), 'a%3Ab%2Cc%25%0A');
});

test('github annotations use warning, error for contract findings and notice for contextual ones', () => {
  assert.deepEqual(formatGithub(entries).split('\n'), [
    '::warning file=a.ts,line=3,col=5,title=pg-query-in-loop::Slow. Detail.',
    '::notice file=c.ts,line=2,col=2,title=pg-query-in-loop::Test.',
    '::error file=b.ts,line=1,col=1,title=pg-transaction-on-pool::Contract broken.',
    '::error file=src/x.ts,line=9,col=1,title=folder-boundary::Boundary.',
  ]);
});

test('configured levels override the default and contextual levels in both CI formats', () => {
  // A contextual finding raised to error, and a contract finding lowered to a warning.
  const configured: ReportEntry[] = [
    { pillar: 'performance', root, report: { findings: [{ ...performanceReport.findings[1], level: 'error' }] } },
    { pillar: 'reliability', root, report: { findings: [{ ...reliabilityReport.findings[0], level: 'warn' }] } },
  ];
  assert.deepEqual(
    JSON.parse(formatSarif(configured)).runs.map(({ results }: SarifRun) => results[0].level),
    ['error', 'warning'],
  );
  assert.match(formatGithub(configured), /^::error .*\n::warning /);
});

test('github annotations escape paths and messages', () => {
  const report = { findings: [{ file: 'we:ird,name.ts', line: 1, column: 1, ruleId: 'r', message: 'a\nb%' }] };
  assert.equal(
    formatGithub([{ pillar: 'performance', root, report }]),
    '::warning file=we%3Aird%2Cname.ts,line=1,col=1,title=r::a%0Ab%25',
  );
});

test('sarif has one run per reported pillar with rules, levels, locations and fingerprints', () => {
  const sarif: SarifLog = JSON.parse(formatSarif(entries));
  assert.equal(sarif.version, '2.1.0');
  assert.match(sarif.$schema, /sarif-2\.1\.0/);
  assert.equal(sarif.runs.length, 3);
  const [performance, reliability, maintainability] = sarif.runs;
  assert.equal(performance.tool.driver.name, 'loadwise');
  assert.deepEqual(
    performance.tool.driver.rules.map(({ id }: SarifRule) => id),
    ['pg-query-in-loop'],
  );
  assert.equal(performance.tool.driver.rules[0].helpUri, 'https://github.com/IbrahimHafez1/loadwise#pg-query-in-loop');
  assert.equal(performance.tool.driver.rules[0].shortDescription.text, descriptionByRule['pg-query-in-loop']);
  assert.deepEqual(
    performance.results.map(({ level }: SarifResult) => level),
    ['warning', 'note'],
  );
  assert.equal(reliability.automationDetails.id, 'loadwise/reliability/');
  assert.deepEqual(
    reliability.tool.driver.rules.map(({ id }: SarifRule) => id),
    ['pg-transaction-on-pool'],
  );
  assert.equal(
    reliability.tool.driver.rules[0].shortDescription.text,
    reliabilityRules.descriptionByRule['pg-transaction-on-pool'],
  );
  assert.equal(reliability.results[0].level, 'error');
  assert.deepEqual(performance.results[0].partialFingerprints, { 'loadwise/findingId/v1': 'aaa111' });
  assert.deepEqual(performance.results[0].locations[0].physicalLocation.region, { startLine: 3, startColumn: 5 });
  assert.equal(performance.results[0].locations[0].physicalLocation.artifactLocation.uri, 'a.ts');
  const { uriBaseId } = performance.results[0].locations[0].physicalLocation.artifactLocation;
  assert.ok(uriBaseId);
  assert.ok(performance.originalUriBaseIds[uriBaseId].description.text);
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

test('scanning another checkout locates source findings in the checked repository', (context) => {
  const caller = project(context, {});
  const repository = project(context, {});
  const directory = path.join(repository, 'example app');
  fs.mkdirSync(path.join(repository, '.git'));
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'tsconfig.json'), tsconfig);
  fs.writeFileSync(path.join(directory, 'a.ts'), slowSource);
  fs.writeFileSync(path.join(directory, 'Dockerfile'), 'FROM node:22\n');
  const github = loadwise(caller, 'check', directory, '--only', 'perf,sec', '--format', 'github');
  assert.equal(github.code, 1, github.stderr);
  assert.match(github.stdout, /file=example app\/a\.ts,/);
  assert.match(github.stdout, /file=example app\/Dockerfile,/);
  for (const [command, file] of [
    ['perf', 'a.ts'],
    ['sec', 'Dockerfile'],
  ]) {
    const result = loadwise(caller, command, '-p', directory, '--format', 'sarif');
    assert.equal(result.code, 1, result.stderr);
    const locations = JSON.parse(result.stdout).runs[0].results.map(
      (result: SarifResult) => result.locations[0].physicalLocation.artifactLocation.uri,
    );
    assert.ok(locations.includes(`example%20app/${file}`), locations.join(', '));
  }
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
  const sarif: SarifLog = JSON.parse(run.stdout);
  assert.deepEqual(
    sarif.runs.map((sarifRun: SarifRun) => sarifRun.automationDetails.id),
    ['loadwise/performance/', 'loadwise/reliability/', 'loadwise/maintainability/', 'loadwise/security/'],
  );
  assert.equal(sarif.runs[0].results.length, 3);
  for (const result of sarif.runs[0].results) {
    assert.ok(result.ruleId && result.message.text);
    assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, 'a.ts');
    assert.match(result.partialFingerprints['loadwise/findingId/v1'], /^[0-9a-f]+$/);
    assert.equal(result.properties.impact, 'medium');
  }
  for (const rule of sarif.runs[0].tool.driver.rules)
    assert.equal(rule.shortDescription.text, performanceDescriptions[rule.id]);
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
