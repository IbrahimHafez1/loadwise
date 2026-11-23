'use strict';

// Runs Loadwise against the recall benchmark in bench/recall/ (public pre-fix advisories + deliberately vulnerable app)
// and verifies that every expected rule fires at its target line.
// Usage: node bench/recall/runner.cjs [--case <id>] [--json]

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RECALL_DIR = __dirname;
const MANIFEST_PATH = path.join(RECALL_DIR, 'manifest.json');
const CLI_PATH = path.resolve(RECALL_DIR, '..', '..', 'bin', 'loadwise.cjs');
const PILLAR_KEYS = { perf: 'performance', sec: 'security', maint: 'maintainability' };

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--case') options.caseId = argv[++i];
    else if (argv[i] === '--json') options.json = true;
  }
  return options;
}

function scanProject(projectDir, pillar) {
  const result = spawnSync(
    process.execPath,
    [CLI_PATH, 'check', projectDir, '--only', pillar, '--json', '--include-contextual'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  return parsed?.[PILLAR_KEYS[pillar]]?.findings ?? [];
}

function normalizePath(file) {
  return file.replaceAll('\\', '/');
}

function evaluateCase(entry, findings) {
  const expectedFile = normalizePath(entry.file);
  const matched = findings.some(
    (finding) =>
      finding.ruleId === entry.ruleId &&
      normalizePath(finding.file).endsWith(expectedFile) &&
      Math.abs(finding.line - entry.line) <= 1,
  );
  return { ...entry, matched };
}

function main(argv) {
  const options = parseArgs(argv);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const cases = options.caseId ? manifest.cases.filter((c) => c.id === options.caseId) : manifest.cases;
  const findingsCache = new Map();
  const results = [];

  for (const entry of cases) {
    const projectDir = path.join(RECALL_DIR, 'cases', entry.project);
    const cacheKey = `${projectDir}::${entry.pillar}`;
    if (!findingsCache.has(cacheKey)) findingsCache.set(cacheKey, scanProject(projectDir, entry.pillar));
    results.push(evaluateCase(entry, findingsCache.get(cacheKey)));
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
module.exports = { evaluateCase, main };
