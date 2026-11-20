'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const test = require('node:test');
const cli = path.join(__dirname, '../../bin/warden-maint.cjs');

const wideOperandCount = 5000;
// Within the duplicate detector's 8192-node body cap, so the long chain is still canonicalized.
const duplicateOperandCount = 2500;

function workspace(context, files) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'maintainability-deep-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), content);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function operandChain(count) {
  return Array.from({ length: count }, (_, index) => `a${index}`).join(' + ');
}

function longSum(name) {
  return [
    `export function ${name}(a0, rest) {`,
    `  const total = ${operandChain(duplicateOperandCount)};`,
    '  const scaled = total * 2;',
    '  return scaled + rest;',
    '}',
  ].join('\n');
}

const deepControlFlow = [
  "import { helper } from './helper';",
  'export function route(items) {',
  '  for (const item of items) {',
  '    if (item.active) {',
  '      while (item.pending) {',
  '        if (item.ready) {',
  '          if (item.urgent) return helper(item);',
  '        }',
  '        item.pending--;',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

test('deeply chained expressions scan without exhausting the call stack', (context) => {
  const directory = workspace(context, {
    'helper.ts': 'export function helper(value) { return value; }\n',
    'wide.ts': [
      "import { helper } from './helper';",
      `export const x = helper(${operandChain(wideOperandCount)});`,
      `export const lazy = () => require('./helper') && ${operandChain(wideOperandCount)};`,
    ].join('\n'),
    'sums.ts': [longSum('first'), longSum('second')].join('\n'),
    'deep.ts': deepControlFlow,
  });
  const result = spawnSync(process.execPath, [cli, directory, '--json', '--include-contextual'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.scannedFiles, 4);
  assert.equal(report.resolvedInternalEdges, 3);
  assert.deepEqual(
    report.findings.map(({ file, line, ruleId }) => ({ file, line, ruleId })),
    [
      { file: 'deep.ts', line: 7, ruleId: 'deep-control-flow' },
      { file: 'sums.ts', line: 1, ruleId: 'duplicate-implementation' },
    ],
  );
  assert.deepEqual(
    report.findings[1].related.map(({ file, line }) => ({ file, line })),
    [{ file: 'sums.ts', line: 6 }],
  );
});
