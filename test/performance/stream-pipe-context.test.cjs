'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { lint, withProgram } = require('./helpers.cjs');

const RULE = 'stream-pipe-unhandled-error';
const onBundledEngine = { skip: process.env.PERF_CHECK_TEST_NATIVE === '1' };

const header = [
  'declare const fs: { createReadStream(p: string): any };',
  'declare function zipFiles(): Promise<{ archive: any; complete: () => Promise<void> }>;',
].join('\n');

const pipeFindings = (source) => lint(`${header}\n${source}`).filter((finding) => finding.ruleId === RULE);

test('marks a pipe in a test source contextual', onBundledEngine, () => {
  const source = `${header}\nexport function copy(res: any) { fs.createReadStream('a').pipe(res); }`;
  const reported = withProgram('export {};', { 'src/__tests__/copy.test.ts': source }, (program) =>
    require('../../lib/performance/analyze.cjs')
      .analyzeFile(
        program,
        program.getSourceFile(path.join(__dirname, 'virtual-project', 'src/__tests__/copy.test.ts')),
      )
      .filter((finding) => finding.ruleId === RULE),
  );
  assert.equal(reported.length, 1);
  assert.match(reported[0].contextualReason, /test source/);
});

test('marks an archive piped while its completion is awaited in try/catch contextual', () => {
  const reported = pipeFindings(
    [
      'export async function zip(res: any) {',
      '  const { archive, complete } = await zipFiles();',
      '  archive.pipe(res);',
      '  try { await complete(); } catch (error) { res.end(); }',
      '}',
    ].join('\n'),
  );
  assert.equal(reported.length, 1);
  assert.match(reported[0].contextualReason, /completion function/);
});

test('keeps a plain stream pipe reported without context', () => {
  const reported = pipeFindings('export function send(res: any) { fs.createReadStream("a").pipe(res); }');
  assert.equal(reported.length, 1);
  assert.equal(reported[0].contextualReason, undefined);
});

test('keeps a completion function that is awaited outside try/catch non-contextual-by-completion', () => {
  const reported = pipeFindings(
    [
      'export async function zip(res: any) {',
      '  const { archive, complete } = await zipFiles();',
      '  archive.pipe(res);',
      '  await complete();',
      '}',
    ].join('\n'),
  );
  assert.equal(reported.length, 1);
  assert.doesNotMatch(reported[0].contextualReason ?? '', /completion function/);
});
