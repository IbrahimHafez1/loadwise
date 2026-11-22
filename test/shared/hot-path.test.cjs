'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { lint } = require('../performance/helpers.cjs');
const { assignFindingIds } = require('../../lib/performance/finding-ids.cjs');
const { sortByImpactWithinFiles } = require('../../lib/shared/impact-levels.cjs');
const { hotPathLabel, hotPathOrder } = require('../../lib/shared/hot-path.cjs');

const isNative = process.env.PERF_CHECK_TEST_NATIVE === '1';
const lookupRule = 'array-repeated-find';
const findLoop = 'rows.map((row) => items.find((item) => item.id === row.id))';
const rankOf = (findings) =>
  findings.filter((finding) => finding.ruleId === lookupRule).map((finding) => finding.hotPath);

// Loaded on use: the native run selects its own compiler before anything binds the TypeScript one.
function lintAs(fileName, source) {
  const { withProgram } = require('../performance/helpers.cjs');
  const { analyzeFile } = require('../../lib/performance/analyze.cjs');
  return withProgram('export {};', { [fileName]: source }, (program) =>
    analyzeFile(program, program.getSourceFile(path.join(__dirname, '..', 'performance', 'virtual-project', fileName))),
  );
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
  assert.equal(rankOf(lint(service, {}))[0].rank, 'unknown');
});

test('a decorated scheduled method ranks as background', () => {
  const source = `declare function Cron(expression: string): any;\nclass Report {\n  @Cron('0 * * * *')\n  run(rows: {id: string}[], items: {id: string}[]) {\n    return ${findLoop};\n  }\n}`;
  assert.equal(rankOf(lint(source, {}))[0].rank, 'background');
});

test('paths rank scripts below unknown and tests last', { skip: isNative }, () => {
  const source = `export function link(rows: {id: string}[], items: {id: string}[]) {\n  return ${findLoop};\n}`;
  assert.equal(rankOf(lintAs('scripts/link.ts', source))[0].rank, 'script');
  assert.equal(rankOf(lintAs('src/link.spec.ts', source))[0].rank, 'test');
  assert.equal(rankOf(lintAs('jobs/link.ts', source))[0].rank, 'background');
});

test('equal impact orders by rank and labels only informative ranks', () => {
  const at = (rank) => ({ file: 'a.ts', impactLevel: 'high', hotPath: rank && { rank, reason: '' } });
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
  const withRank = [{ file: 'a.ts', line: 1, ruleId: 'rule', hotPath: { rank: 'request', reason: 'x' } }];
  const withoutRank = [{ file: 'a.ts', line: 1, ruleId: 'rule' }];
  const root = path.resolve('.');
  assert.equal(assignFindingIds(withRank, root)[0].id, assignFindingIds(withoutRank, root)[0].id);
});
