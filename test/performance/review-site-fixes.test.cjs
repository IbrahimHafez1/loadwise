'use strict';

const { before, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

function findingFor(context, ruleId, source) {
  const { findings } = scanWithFixes(context, { 'a.ts': source });
  return findings.find((finding) => finding.ruleId === ruleId);
}

const literalHeader =
  'declare function a(): Promise<number>;\ndeclare function b(): Promise<number>;\ndeclare function wrap(value: object): object;\n';

test('arrow body that wraps the literal in a call keeps the call', (context) => {
  const finding = findingFor(
    context,
    'serial-awaits-in-literal',
    `${literalHeader}export const build = async () => wrap({ x: await a(), y: await b() });`,
  );
  if (!finding.fix) return;
  assert.match(onlyChange(finding).after, /return wrap\(\{ x: xValue, y: yValue \}\);/);
});

const queueFiles = {
  'node_modules/bullmq/index.d.ts':
    'export declare class Queue { add(name: string, data: any, opts?: any): Promise<{ id: string }>; addBulk(jobs: any[]): Promise<any[]>; }',
};

test('queue add loop with a comment in its body is not rewritten away from the comment', (context) => {
  const { findings } = scanWithFixes(context, {
    ...queueFiles,
    'src/app.ts': `import { Queue } from 'bullmq';
export async function run(queue: Queue, ids: string[]) {
  for (const id of ids) {
    // retries are handled by the worker
    await queue.add('job', { id });
  }
}
`,
  });
  const finding = findings.find((entry) => entry.ruleId === 'queue-add-in-loop');
  assert.ok(finding);
  assert.equal(finding.fix, undefined);
});
