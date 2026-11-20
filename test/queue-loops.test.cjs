'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

const files = {
  'node_modules/bullmq/index.d.ts': `export declare class Queue { add(name: string, data: any, opts?: any): Promise<{ id: string }>; addBulk(jobs: any[]): Promise<any[]>; }`,
  'node_modules/other/index.d.ts': `export declare class Queue { add(name: string, data: any): Promise<void>; }`,
};

function scan(context, source) {
  return scanWithFixes(context, { ...files, 'src/app.ts': source }).findings.filter(
    (finding) => finding.ruleId === 'queue-add-in-loop',
  );
}

test('rewrites a for-of with one add into addBulk', (context) => {
  const findings = scan(
    context,
    `import { Queue } from 'bullmq';
export async function run(queue: Queue, ids: string[]) {
  for (const id of ids) {
    await queue.add('job', { id }, { attempts: 3 });
  }
}
`,
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /addBulk/);
  assert.match(
    onlyChange(findings[0]).after,
    /await queue\.addBulk\(ids\.map\(\(id\) => \(\{ name: 'job', data: \{ id \}, opts: \{ attempts: 3 \} \}\)\)\);/,
  );
});

test('rewrites Promise.all over map into addBulk', (context) => {
  const findings = scan(
    context,
    `import { Queue } from 'bullmq';
export async function run(queue: Queue, ids: string[]) {
  await Promise.all(ids.map((id) => queue.add('job', { id })));
}
`,
  );
  assert.equal(findings.length, 1);
  assert.match(
    onlyChange(findings[0]).after,
    /await queue\.addBulk\(ids\.map\(\(id\) => \(\{ name: 'job', data: \{ id \} \}\)\)\);/,
  );
});

test('skips array literals, dependent loops, non-queue types and calls outside loops', (context) => {
  const findings = scan(
    context,
    `import { Queue } from 'bullmq';
import { Queue as Other } from 'other';
export async function run(queue: Queue, other: Other, ids: string[]) {
  for (const name of ['a', 'b', 'c']) await queue.add(name, {});
  for (const id of ids) await other.add('job', { id });
  await queue.add('once', {});
  let previous = '';
  while (previous !== 'done') {
    const job = await queue.add('step', { previous });
    previous = job.id;
  }
}
`,
  );
  assert.equal(findings.length, 0);
});
