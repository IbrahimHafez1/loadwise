'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const test = require('node:test');
const cli = path.join(__dirname, '../bin/warden-maint.cjs');

function workspace(context, files) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'maintainability-cli-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), content);
  context.after(() => {
    for (const file of Object.keys(files)) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
  });
  return (...args) => spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: directory, encoding: 'utf8' });
}

test('generated-source advisories stay retrievable and contract thresholds are independent', (context) => {
  const run = workspace(context, {
    'generated.ts': [
      '// GENERATED from canonical schema - do not edit.',
      'export function dispatch(value) {',
      ...Array.from({ length: 16 }, (_, index) => `if (value === ${index}) return ${index};`),
      '}',
    ].join('\n'),
  });
  const basic = run('--fail-on', 'all');
  assert.equal(basic.status, 0, basic.stderr);
  assert.deepEqual(JSON.parse(basic.stdout).findings, []);
  assert.equal(JSON.parse(basic.stdout).contextualFindingCount, 1);
  const expanded = run('--include-contextual', '--fail-on', 'all');
  assert.equal(expanded.status, 1, expanded.stderr);
  assert.match(JSON.parse(expanded.stdout).findings[0].contextualReason, /generated/);
  assert.equal(run('--include-contextual').status, 0);
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
    JSON.parse(advisory.stdout).findings.map((f) => f.ruleId),
    ['dependency-cycle'],
  );
  assert.equal(run('--graph', 'graph.json', '--fail-on', 'all').status, 1);
  const enforced = run('--graph', 'graph.json', '--config', 'policy.json');
  assert.equal(enforced.status, 1, enforced.stderr);
  const report = JSON.parse(enforced.stdout);
  assert.equal(report.contractFindingCount, 1);
  assert.equal(report.findings.find((f) => f.ruleId === 'folder-boundary').line, 3);
  assert.equal(JSON.parse(run('--graph', 'graph.json', '--config', 'excluded.json').stdout).graphEdges, 0);
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
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.languageCounts, { TypeScript: 1, Python: 1 });
  assert.deepEqual(
    report.findings.map((f) => f.ruleId),
    ['file-placement', 'query-mutates-state'],
  );
  assert.equal(report.contractFindingCount, 2);
});
