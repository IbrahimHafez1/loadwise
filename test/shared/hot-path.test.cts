import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { lint } from '../performance/helpers.cjs';
import { assignFindingIds } from '../../lib/performance/finding-ids.cjs';
import { sortByImpactWithinFiles } from '../../lib/shared/impact-levels.cjs';
import { hotPathLabel, hotPathOrder } from '../../lib/shared/hot-path.cjs';
import type { Finding, ProgramAdapter } from '../../lib/shared/types.cjs';
import type * as Helpers from '../performance/helpers.cjs';
import type * as Analyze from '../../lib/performance/analyze.cjs';

const isNative = process.env.PERF_CHECK_TEST_NATIVE === '1';
const lookupRule = 'array-repeated-find';
const findLoop = 'rows.map((row) => items.find((item) => item.id === row.id))';
const rankOf = (findings: Finding[]) =>
  findings.filter((finding: Finding) => finding.ruleId === lookupRule).map((finding: Finding) => finding.hotPath);

// Loaded on use: the native run selects its own compiler before anything binds the TypeScript one.
function lintAs(fileName: string, source: string) {
  const { withProgram }: typeof Helpers = require('../performance/helpers.cjs');
  const { analyzeFile }: typeof Analyze = require('../../lib/performance/analyze.cjs');
  return withProgram('export {};', { [fileName]: source }, (program: ProgramAdapter) => {
    const target = path.normalize(path.join(__dirname, '..', 'performance', 'virtual-project', fileName));
    const sourceFile = program.getSourceFiles?.().find((candidate) => path.normalize(candidate.fileName) === target);
    assert.ok(sourceFile);
    return analyzeFile(program, sourceFile);
  });
}

test('a finding inside a request handler ranks as request', () => {
  const source = `export function list(req, res, rows: {id: string}[], items: {id: string}[]) {\n  res.json(${findLoop});\n}`;
  assert.deepEqual(rankOf(lint(source, {})), [{ rank: 'request', reason: 'inside a request handler' }]);
});

test('a project function called from a request handler ranks as request, and an unreferenced one as unknown', () => {
  const service = `export function link(rows: {id: string}[], items: {id: string}[]) {\n  return ${findLoop};\n}`;
  const route = "import { link } from './main.js';\nexport function list(req, res) {\n  res.json(link([], []));\n}";
  assert.deepEqual(rankOf(lint(service, { 'route.ts': route })), [
    { rank: 'request', reason: 'called from a request handler' },
  ]);
  assert.equal(rankOf(lint(service, {}))[0]?.rank, 'unknown');
});

test('a decorated scheduled method ranks as background', () => {
  const source = `declare function Cron(expression: string): any;\nclass Report {\n  @Cron('0 * * * *')\n  run(rows: {id: string}[], items: {id: string}[]) {\n    return ${findLoop};\n  }\n}`;
  assert.equal(rankOf(lint(source, {}))[0]?.rank, 'background');
});

test('paths rank scripts below unknown and tests last', { skip: isNative }, () => {
  const source = `export function link(rows: {id: string}[], items: {id: string}[]) {\n  return ${findLoop};\n}`;
  assert.equal(rankOf(lintAs('scripts/link.ts', source))[0]?.rank, 'script');
  assert.equal(rankOf(lintAs('src/link.spec.ts', source))[0]?.rank, 'test');
  assert.equal(rankOf(lintAs('jobs/link.ts', source))[0]?.rank, 'background');
});

test('equal impact orders by rank and labels only informative ranks', () => {
  const at = (rank: string | undefined): Finding => ({
    file: 'a.ts',
    ruleId: 'rule',
    message: '',
    impactLevel: 'high',
    hotPath: rank ? { rank, reason: '' } : undefined,
  });
  const sorted = sortByImpactWithinFiles([at('test'), at('script'), at(undefined), at('background'), at('request')]);
  assert.deepEqual(
    sorted.map((finding) => finding.hotPath?.rank),
    ['request', 'background', undefined, 'script', 'test'],
  );
  assert.equal(hotPathLabel(at('request')), 'request path');
  assert.equal(hotPathLabel(at('unknown')), undefined);
  assert.equal(hotPathOrder(at('unknown')), hotPathOrder(at(undefined)));
});

test('the rank never changes a finding id', () => {
  const withRank: Finding[] = [
    { file: 'a.ts', line: 1, ruleId: 'rule', message: '', hotPath: { rank: 'request', reason: 'x' } },
  ];
  const withoutRank: Finding[] = [{ file: 'a.ts', line: 1, ruleId: 'rule', message: '' }];
  const root = path.resolve('.');
  assert.equal(assignFindingIds(withRank, root)[0]?.id, assignFindingIds(withoutRank, root)[0]?.id);
});
