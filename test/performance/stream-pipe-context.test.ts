import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { lint, withProgram } from './helpers.js';
import type { Finding, ProgramAdapter } from '../../lib/shared/types.js';
import { findSourceFile } from '../types/source-files.js';
import { reasonOf } from '../types/finding-reason.js';
import { analyzeFile } from '../../lib/performance/analyze.js';

const RULE = 'stream-pipe-unhandled-error';
const onBundledEngine = { skip: process.env.PERF_CHECK_TEST_NATIVE === '1' };

const header = [
  'declare const fs: { createReadStream(p: string): any };',
  'declare function zipFiles(): Promise<{ archive: any; complete: () => Promise<void> }>;',
].join('\n');

const pipeFindings = (source: string) =>
  lint(`${header}\n${source}`).filter((finding: Finding) => finding.ruleId === RULE);

test('marks a pipe in a test source contextual', onBundledEngine, () => {
  const source = `${header}\nexport function copy(res: any) { fs.createReadStream('a').pipe(res); }`;
  const reported = withProgram('export {};', { 'src/__tests__/copy.test.ts': source }, (program: ProgramAdapter) =>
    analyzeFile(
      program,
      findSourceFile(
        program,
        (file) =>
          path.resolve(file.fileName) ===
          path.join(import.meta.dirname, 'virtual-project', 'src/__tests__/copy.test.ts'),
      ),
    ).filter((finding) => finding.ruleId === RULE),
  );
  assert.equal(reported.length, 1);
  assert.match(reasonOf(reported[0]), /test source/);
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
  assert.match(reasonOf(reported[0]), /completion function/);
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
