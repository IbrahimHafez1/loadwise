// perf and sec selected together build the TypeScript Program once and report what separate runs
// report.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { analyzeSources, performanceAnalyzers } from '../../lib/performance/projects.cjs';
import * as security from '../../lib/security/cli.cjs';
import type { TestContext } from 'node:test';
import type { SourceAnalyzer } from '../../lib/performance/types/source-analyzer.cjs';
import type { Finding, ProgramAdapter } from '../../lib/shared/types.cjs';

function project(context: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-shared-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, types: [] }, include: ['*.ts'] }),
    'node_modules/@types/pg/index.d.ts': 'export class Pool { query(text: string): Promise<unknown> }',
    'query.ts': [
      "import type { Pool } from 'pg';",
      'export const load = (pool: Pool, table: string) => pool.query(`SELECT * FROM ${table}`);',
      'export const allowed = (ids: string[], all: string[]) => ids.filter((id) => all.includes(id));',
    ].join('\n'),
  };
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return path.join(root, 'tsconfig.json');
}

// Wraps each analyzer so the test sees which Program every file was analyzed with.
function recordingPrograms(analyzers: SourceAnalyzer[]) {
  const programs = new Set<ProgramAdapter>();
  const wrapped = analyzers.map(({ pillar, analyzeFile }): SourceAnalyzer => ({
    pillar,
    analyzeFile(program, ...rest) {
      programs.add(program);
      return analyzeFile(program, ...rest);
    },
  }));
  return { programs, analyzers: wrapped };
}

const summary = (findings: Finding[]) => findings.map(({ line, ruleId, pillar }) => [line, ruleId, pillar]);

test('one Program serves both analyzers and stamps each finding with its pillar', (context) => {
  const config = project(context);
  const recorded = recordingPrograms([...performanceAnalyzers, security.analyzer]);
  const shared = analyzeSources({ project: config, files: [], analyzers: recorded.analyzers });
  assert.equal(recorded.programs.size, 1);
  const performanceOnly = analyzeSources({ project: config, files: [] });
  const securityOnly = analyzeSources({ project: config, files: [], analyzers: [security.analyzer] });
  assert.deepEqual(summary(performanceOnly.findings), [
    [2, 'sql-select-star-in-query', undefined],
    [3, 'array-repeated-membership', undefined],
  ]);
  assert.deepEqual(summary(securityOnly.findings), [[2, 'pg-dynamic-query-text', undefined]]);
  assert.deepEqual(summary(shared.findings), [
    [2, 'pg-dynamic-query-text', 'security'],
    [2, 'sql-select-star-in-query', 'performance'],
    [3, 'array-repeated-membership', 'performance'],
  ]);
});
