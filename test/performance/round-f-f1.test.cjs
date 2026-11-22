'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { scanWithFixes } = require('./site-fix-helpers.cjs');

function findingsFor(context, ruleId, source) {
  return scanWithFixes(context, { 'src.ts': source }).findings.filter((finding) => finding.ruleId === ruleId);
}

function applied(source, fix) {
  return fix.changes.reduce((text, change) => text.replace(change.before, () => change.after), source);
}

test('an unawaited async guard in an async function gets an await fix without review', (context) => {
  const source = `async function assertMutable(id: string): Promise<void> {
  if (!id) throw new Error('locked');
}
declare function save(id: string): Promise<void>;
export async function update(id: string) {
  assertMutable(id);
  await save(id);
}
`;
  const [finding] = findingsFor(context, 'floating-promise', source);
  assert.equal(finding.fix.requiresReview, undefined);
  assert.match(applied(source, finding.fix), /\n {2}await assertMutable\(id\);\n/);
  assert.deepEqual(findingsFor(context, 'floating-promise', applied(source, finding.fix)), []);
});

test('the await fix needs review inside a loop, for background-looking names and for contextual findings', (context) => {
  const source = `declare function save(id: string): Promise<void>;
declare function publish(topic: string): Promise<void>;
async function quietly(): Promise<void> {
  try {
    await save('a');
  } catch {
    return;
  }
}
export async function run(ids: string[]) {
  for (const id of ids) {
    save(id);
  }
  publish('updated');
  quietly();
}
`;
  const findings = findingsFor(context, 'floating-promise', source);
  assert.equal(findings.length, 3);
  for (const finding of findings) assert.equal(finding.fix.requiresReview, true);
  assert.match(findings[0].fix.note, /Each iteration now waits/);
});

test('no await fix outside async functions, for forEach findings or for nested statements', (context) => {
  const source = `declare function save(id: string): Promise<void>;
export function handle(req: object) {
  save('a');
}
export async function run(ids: string[], flag: boolean) {
  ids.forEach(async (id) => {
    await save(id);
  });
  if (flag) save('b');
}
`;
  const findings = findingsFor(context, 'floating-promise', source);
  assert.equal(findings.length, 3);
  for (const finding of findings) assert.equal(finding.fix, undefined);
});

test('a catch that reruns the escaped work is contextual and gets no return await fix', (context) => {
  const source = `declare function withCache<T>(load: () => Promise<T>): Promise<T>;
declare function loadDuringOutage(id: string): Promise<string>;
export async function cached<T>(load: () => Promise<T>) {
  try {
    return withCache(load);
  } catch {
    return await load();
  }
}
export async function state(id: string) {
  try {
    return loadDuringOutage(id);
  } catch {
    return loadDuringOutage(id);
  }
}
`;
  const findings = findingsFor(context, 'promise-return-escapes-catch', source);
  assert.equal(findings.length, 2);
  for (const finding of findings) {
    assert.match(finding.contextualReason, /run that work twice/);
    assert.equal(finding.fix, undefined);
  }
});

test('a return inside a try within a for...of loop gets a reviewed return await fix', (context) => {
  const source = `declare function request(url: string): Promise<{ ok: boolean; json(): Promise<string> }>;
export async function predict(urls: string[]) {
  for (const url of urls) {
    try {
      const response = await request(url);
      if (response.ok) {
        return response.json();
      }
    } catch {
      continue;
    }
  }
  throw new Error('no server');
}
`;
  const [finding] = findingsFor(context, 'promise-return-escapes-catch', source);
  assert.equal(finding.fix.requiresReview, true);
  assert.match(finding.fix.note, /for\.\.\.of loop now closes its iterator/);
  assert.match(applied(source, finding.fix), /return await response\.json\(\);/);
});
