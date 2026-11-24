// Runs Loadwise against the recall benchmark in bench/recall/ (public pre-fix advisories +
// deliberately vulnerable app) and verifies that every expected rule fires at its target line.
// Usage: node bench/recall/runner.cjs [--case <id>] [--json]

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Finding, Pillar } from '../../lib/shared/types.cjs';

interface RecallOptions {
  caseId?: string;
  json?: boolean;
}

interface RecallCase {
  id: string;
  project: string;
  pillar: Pillar;
  ruleId: string;
  file: string;
  line: number;
}

interface RecallManifest {
  cases: RecallCase[];
}

interface CaseResult extends RecallCase {
  matched: boolean;
}

const RECALL_DIR = __dirname;
const MANIFEST_PATH = path.join(RECALL_DIR, 'manifest.json');
const CLI_PATH = path.resolve(RECALL_DIR, '..', '..', 'bin', 'loadwise.cjs');
const PILLAR_KEYS: Record<Pillar, string> = { perf: 'performance', sec: 'security', maint: 'maintainability' };

function parseArgs(argv: readonly string[]): RecallOptions {
  const options: RecallOptions = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--case') options.caseId = argv[++i];
    else if (argv[i] === '--json') options.json = true;
  }
  return options;
}

function scanProject(projectDir: string, pillar: Pillar): Finding[] {
  const result = spawnSync(
    process.execPath,
    [CLI_PATH, 'check', projectDir, '--only', pillar, '--json', '--include-contextual'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  return parsed?.[PILLAR_KEYS[pillar]]?.findings ?? [];
}

function normalizePath(file: string): string {
  return file.replaceAll('\\', '/');
}

function evaluateCase(entry: RecallCase, findings: Finding[]): CaseResult {
  const expectedFile = normalizePath(entry.file);
  const matched = findings.some(
    (finding: Finding) =>
      finding.ruleId === entry.ruleId &&
      finding.file !== undefined &&
      normalizePath(finding.file).endsWith(expectedFile) &&
      finding.line !== undefined &&
      Math.abs(finding.line - entry.line) <= 1,
  );
  return { ...entry, matched };
}

function main(argv: readonly string[]): number {
  const options = parseArgs(argv);
  const manifest: RecallManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const cases = options.caseId
    ? manifest.cases.filter((recallCase) => recallCase.id === options.caseId)
    : manifest.cases;
  const findingsCache = new Map<string, Finding[]>();
  const results: CaseResult[] = [];

  for (const entry of cases) {
    const projectDir = path.join(RECALL_DIR, 'cases', entry.project);
    const cacheKey = `${projectDir}::${entry.pillar}`;
    if (!findingsCache.has(cacheKey)) findingsCache.set(cacheKey, scanProject(projectDir, entry.pillar));
    results.push(evaluateCase(entry, findingsCache.get(cacheKey) ?? []));
  }

  const hits = results.filter((r) => r.matched).length;
  const recall = results.length ? Number((hits / results.length).toFixed(4)) : 1;

  if (options.json) {
    console.log(
      JSON.stringify({ total: results.length, hits, missed: results.length - hits, recall, results }, null, 2),
    );
  } else {
    for (const r of results) {
      console.log(`${r.matched ? 'PASS' : 'MISS'} [${r.pillar}/${r.ruleId}] ${r.id} (${r.file}:${r.line})`);
    }
    console.log(`\nRecall: ${hits}/${results.length} (${(recall * 100).toFixed(1)}%)`);
  }
  return hits === results.length ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
export { evaluateCase, main };
