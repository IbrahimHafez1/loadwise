import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { parseReport } from '../types/cli-report.js';
import { relatedOf } from '../types/finding-related.js';
import type { FileMap } from '../types/project-files.js';
const cli = path.join(import.meta.dirname, '../../bin/loadwise.js');

const wideOperandCount = 5000;
// Within the duplicate detector's 8192-node body cap, so the long chain is still canonicalized.
const duplicateOperandCount = 2500;

function workspace(context: TestContext, files: FileMap) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'maintainability-deep-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), content);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function operandChain(count: number) {
  return Array.from({ length: count }, (_, index) => `a${index}`).join(' + ');
}

function longSum(name: string) {
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
  const result = spawnSync(process.execPath, [cli, 'maint', directory, '--json', '--include-contextual'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const report = parseReport(result.stdout);
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
    relatedOf(report.findings[1]).map(({ file, line }) => ({ file, line })),
    [{ file: 'sums.ts', line: 6 }],
  );
});
