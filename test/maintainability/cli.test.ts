import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { parseReport } from '../types/cli-report.js';
import type { FileMap } from '../types/project-files.js';
const cli = path.join(import.meta.dirname, '../../bin/loadwise.js');

function workspace(context: TestContext, files: FileMap) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'maintainability-cli-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), content);
  context.after(() => {
    for (const file of Object.keys(files)) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
  });
  return (...args: string[]) =>
    spawnSync(process.execPath, [cli, 'maint', ...args, '--json'], { cwd: directory, encoding: 'utf8' });
}

test('generated-source advisories stay retrievable and contract thresholds are independent', (context) => {
  const run = workspace(context, {
    'generated.ts': [
      '// GENERATED from canonical schema - do not edit.',
      'export function dispatch(value) {',
      ...Array.from({ length: 16 }, (_, index) => `if (value === ${index}) console.log(${index});`),
      '}',
    ].join('\n'),
  });
  const basic = run('--fail-on', 'all');
  assert.equal(basic.status, 0, basic.stderr);
  assert.deepEqual(parseReport(basic.stdout).findings, []);
  assert.equal(parseReport(basic.stdout).contextualFindingCount, 1);
  const expanded = run('--include-contextual', '--fail-on', 'all');
  assert.equal(expanded.status, 1, expanded.stderr);
  assert.match(String(parseReport(expanded.stdout).findings[0]?.contextualReason), /generated/);
  assert.equal(run('--include-contextual').status, 0);
});

test('ignore globs that leave no sources return a successful empty report', (context) => {
  const run = workspace(context, {
    'source.ts': 'export const importedValue = 1;',
    'loadwise.config.json': JSON.stringify({ ignore: ['source.ts'] }),
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stderr,
    /every source file matches "ignore" in .*loadwise\.config\.json; no files were left to check/,
  );
  const report = parseReport(result.stdout);
  assert.equal(report.scannedFiles, 0);
  assert.deepEqual(report.findings, []);
});

test('a file that does not parse is skipped, listed in skippedFiles and makes the run exit 2', (context) => {
  const run = workspace(context, {
    'good.ts': 'export const goodValue = 1;',
    'broken.ts': 'export const = ;',
  });
  const result = run();
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /broken\.ts:1:\d+ .* Skipped that file, which does not parse/);
  const report = parseReport(result.stdout);
  const [skipped] = report.skippedFiles ?? [];
  assert.equal(report.skippedFiles?.length, 1);
  assert.ok(skipped);
  assert.equal(skipped.file, 'broken.ts');
  assert.match(skipped.reason, /^1:\d+ /);
});

test('an unparsable file named in ignore is not parsed and does not cause exit 2', (context) => {
  const run = workspace(context, {
    'good.ts': 'export const goodValue = 1;',
    'broken-fixture.ts': 'export const = ;',
    'loadwise.config.json': JSON.stringify({ ignore: ['broken-fixture.ts'] }),
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /does not parse/);
  assert.equal(parseReport(result.stdout).skippedFiles, undefined);
});

test('a project without supported sources still fails when ignore globs match no sources', (context) => {
  const run = workspace(context, {
    'notes.txt': 'Nothing to check.',
    'loadwise.config.json': JSON.stringify({ ignore: ['source.ts'] }),
  });
  const result = run();
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /No supported source files or placement rules/);
});

test('imports a graph from any language, enforces configured boundaries and validates the evidence', (context) => {
  const files = ['domain/order.ex', 'http/handler.dart'];
  const edges = [
    { from: files[0], to: files[1], line: 3, column: 4 },
    { from: files[1], to: files[0], line: 5, column: 1 },
  ];
  const run = workspace(context, {
    'graph.json': JSON.stringify({ files, edges }),
    'policy.json': JSON.stringify({ boundaries: [{ from: 'domain', disallow: ['http'] }] }),
    'bad.json': JSON.stringify({ files, edges: [{ ...edges[0], from: '../outside' }] }),
    'excluded.json': JSON.stringify({ exclude: ['http'] }),
  });
  const advisory = run('--graph', 'graph.json');
  assert.equal(advisory.status, 0, advisory.stderr);
  assert.deepEqual(
    parseReport(advisory.stdout).findings.map((finding) => finding.ruleId),
    ['dependency-cycle'],
  );
  assert.equal(run('--graph', 'graph.json', '--fail-on', 'all').status, 1);
  const enforced = run('--graph', 'graph.json', '--config', 'policy.json');
  assert.equal(enforced.status, 1, enforced.stderr);
  const report = parseReport(enforced.stdout);
  assert.equal(report.contractFindingCount, 1);
  assert.equal(report.findings.find((finding) => finding.ruleId === 'folder-boundary')?.line, 3);
  assert.equal(parseReport(run('--graph', 'graph.json', '--config', 'excluded.json').stdout).graphEdges, 0);
  assert.equal(run('--graph', 'bad.json').status, 2);
});

test('source coverage and explicit query contract work through the executable', (context) => {
  const run = workspace(context, {
    'service.ts':
      'export class Ledger { balance=0;\n/** @maintainabilityQuery */\nread() { this.balance++; return this.balance; } }',
    'order.py': 'def total(items):\n    return sum(items)\n',
    'policy.json': JSON.stringify({ placement: [{ suffix: '.py', under: ['services'] }] }),
  });
  const result = run('--config', 'policy.json');
  assert.equal(result.status, 1, result.stderr);
  const report = parseReport(result.stdout);
  assert.deepEqual(report.languageCounts, { TypeScript: 1, Python: 1 });
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ['file-placement', 'query-mutates-state'],
  );
  assert.equal(report.contractFindingCount, 2);
});
