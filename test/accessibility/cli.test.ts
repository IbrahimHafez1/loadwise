// `loadwise a11y` shares the source pass with only the accessibility analyzer, reads markup files beside it and skips
// itself on projects without frontend sources.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { Finding } from '../../lib/shared/types.js';

interface SourceReport {
  scannedFiles: number;
  findings: Finding[];
  baselineHidden?: number;
}

interface CheckReport {
  accessibility: SourceReport | null;
  performance?: SourceReport | null;
}

interface BaselineDocument {
  pillars: Record<string, { findings: unknown[] }>;
}

interface SarifDocument {
  runs: { automationDetails: { id: string } }[];
}

const bin = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const tsconfig = JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'NodeNext', jsx: 'preserve', lib: ['ES2022', 'DOM'], types: [] },
  include: ['*.tsx', '*.ts'],
});
const tsxSource = 'export const Logo = () => <img src="logo.png" />;\n';
const htmlSource = '<html><body><img src="x"><button>Go</button></body></html>\n';

function createProject(context: TestContext, files: Record<string, string>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-a11y-cli-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), text);
  return directory;
}

function frontendProject(context: TestContext): string {
  return createProject(context, { 'tsconfig.json': tsconfig, 'Logo.tsx': tsxSource, 'index.html': htmlSource });
}

function backendProject(context: TestContext): string {
  return createProject(context, {
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext' }, include: ['*.ts'] }),
    'package.json': JSON.stringify({ name: 'backend', dependencies: { express: '5.0.0' } }),
    'server.ts': 'export const port = 3000;\n',
  });
}

function run(directory: string, args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], { cwd: directory, encoding: 'utf8' });
}

function accessibilityFindingsOf(report: SourceReport): Finding[] {
  assert.ok(Array.isArray(report.findings));
  for (const finding of report.findings) assert.ok(finding.ruleId.startsWith('a11y-'), finding.ruleId);
  return report.findings;
}

test('a11y --help lists its own flags', () => {
  const help = run(process.cwd(), ['a11y', '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /loadwise a11y/);
  assert.match(help.stdout, /\.html/);
});

test('check --only a11y skips a backend-only project with a note and a null report', (context) => {
  const directory = backendProject(context);
  const result = run(directory, ['check', '.', '--only', 'a11y', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /no frontend sources .* skipped the accessibility checker/);
  assert.deepEqual(JSON.parse(result.stdout), { accessibility: null });
});

test('a11y on a backend-only project reports no findings', (context) => {
  const directory = backendProject(context);
  const result = run(directory, ['a11y', '-p', '.', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(accessibilityFindingsOf(JSON.parse(result.stdout)), []);
});

test('check --only a11y reads the tsx and html files of a frontend project', (context) => {
  const directory = frontendProject(context);
  const result = run(directory, ['check', '.', '--only', 'a11y', '--json']);
  assert.ok([0, 1].includes(result.status ?? -1), result.stderr);
  const report: CheckReport = JSON.parse(result.stdout);
  assert.ok(report.accessibility);
  assert.ok(report.accessibility.scannedFiles >= 2, 'the tsx and the html file are both scanned');
  const findings = accessibilityFindingsOf(report.accessibility);
  const files = new Set(findings.map((finding) => path.basename(finding.file ?? '')));
  if (findings.length) assert.ok(files.has('index.html'), 'findings include the markup file');
});

test('a11y checks a markup file named on the command line', (context) => {
  const directory = frontendProject(context);
  const result = run(directory, ['a11y', 'index.html', '--json']);
  assert.ok([0, 1].includes(result.status ?? -1), result.stderr);
  const report: SourceReport = JSON.parse(result.stdout);
  assert.equal(report.scannedFiles, 1);
  for (const finding of accessibilityFindingsOf(report)) assert.equal(finding.file, 'index.html');
});

test('check --only perf,a11y shares one pass and prints both reports', (context) => {
  const directory = frontendProject(context);
  const result = run(directory, ['check', '.', '--only', 'perf,a11y', '--json']);
  assert.ok([0, 1].includes(result.status ?? -1), result.stderr);
  const report: CheckReport = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(report).sort(), ['accessibility', 'performance']);
  assert.ok(report.accessibility);
  accessibilityFindingsOf(report.accessibility);
});

test('check --only sec,a11y shares one pass and prints both reports', (context) => {
  const directory = frontendProject(context);
  const result = run(directory, ['check', '.', '--only', 'sec,a11y', '--json']);
  assert.ok([0, 1].includes(result.status ?? -1), result.stderr);
  const report: CheckReport = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(report).sort(), ['accessibility', 'security']);
  assert.ok(report.accessibility);
  assert.ok(report.accessibility.scannedFiles >= 2);
  accessibilityFindingsOf(report.accessibility);
});

test('check --workspace on a backend-only package skips the accessibility checker', (context) => {
  const directory = createProject(context, {
    'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
  });
  const packages: Record<string, Record<string, string>> = {
    api: { 'server.ts': 'export const port = 3000;\n' },
    web: { 'index.html': htmlSource },
  };
  for (const [name, files] of Object.entries(packages)) {
    const packageDirectory = path.join(directory, 'packages', name);
    fs.mkdirSync(packageDirectory, { recursive: true });
    fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ name }));
    fs.writeFileSync(path.join(packageDirectory, 'tsconfig.json'), tsconfig);
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(packageDirectory, file), text);
  }
  const result = run(directory, ['check', '.', '--only', 'a11y', '--workspace', 'api', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /no frontend sources/);
});

test('--ignore accepts an accessibility rule and rejects unknown ones', (context) => {
  const directory = frontendProject(context);
  const accepted = run(directory, ['a11y', '-p', '.', '--ignore', 'a11y-img-missing-alt', '--json']);
  assert.ok([0, 1].includes(accepted.status ?? -1), accepted.stderr);
  const report: SourceReport = JSON.parse(accepted.stdout);
  assert.ok(!report.findings.some((finding) => finding.ruleId === 'a11y-img-missing-alt'));
  const rejected = run(directory, ['a11y', '-p', '.', '--ignore', 'a11y-not-a-rule']);
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /Unknown source rule: a11y-not-a-rule/);
});

test('the baseline file records an accessibility section', (context) => {
  const directory = frontendProject(context);
  const written = run(directory, ['a11y', '-p', '.', '--write-baseline']);
  assert.equal(written.status, 0, written.stderr);
  const document: BaselineDocument = JSON.parse(
    fs.readFileSync(path.join(directory, 'loadwise-baseline.json'), 'utf8'),
  );
  assert.deepEqual(Object.keys(document.pillars), ['accessibility']);
  const compared = run(directory, ['a11y', '-p', '.', '--baseline', '--json']);
  assert.equal(compared.status, 0, compared.stderr);
  assert.deepEqual(accessibilityFindingsOf(JSON.parse(compared.stdout)), []);
});

test('SARIF output has an accessibility run', (context) => {
  const directory = frontendProject(context);
  const result = run(directory, ['check', '.', '--only', 'a11y', '--format', 'sarif']);
  assert.ok([0, 1].includes(result.status ?? -1), result.stderr);
  const sarif: SarifDocument = JSON.parse(result.stdout);
  assert.equal(sarif.runs.length, 1);
  assert.equal(sarif.runs[0].automationDetails.id, 'loadwise/accessibility/');
});

test('the config schema accepts a11y as a checker and the accessibility rule ids', () => {
  const schemaText = fs.readFileSync(
    path.resolve(import.meta.dirname, '../../schema/loadwise.config.schema.json'),
    'utf8',
  );
  const schema: { properties: { checkers: { items: { enum: string[] } } } } = JSON.parse(schemaText);
  assert.ok(schema.properties.checkers.items.enum.includes('a11y'));
  assert.ok(schemaText.includes('"a11y-img-missing-alt"'));
});
