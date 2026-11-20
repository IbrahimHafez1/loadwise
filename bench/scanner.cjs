'use strict';

const { performance } = require('node:perf_hooks');
const startup = performance.now();
const assert = require('node:assert/strict');
const path = require('node:path');
const { withProgram } = require('../test/helpers.cjs');
const { analyzeFile } = require('../lib/analyze.cjs');
const moduleLoadMs = performance.now() - startup;

const routeModuleCount = 40;
const routesPerModule = 6;
const modelModuleCount = 12;
const warmupRuns = 2;
const sampleCount = 9;
const expected = [];
const files = {
  'node_modules/pg/index.d.ts': `export declare class Pool {
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>
  }`,
};

for (let moduleIndex = 0; moduleIndex < routeModuleCount; moduleIndex++) {
  const filename = `routes-${moduleIndex}.ts`;
  const lines = ["import type {Pool} from 'pg';", 'declare function clean(value: string): string;'];
  const usesFilesystem = moduleIndex % 5 === 0;
  if (usesFilesystem) lines.push("import {readFileSync as loadFile} from 'node:fs';");
  function addFinding(line, token, ruleId) {
    expected.push([filename, lines.length + 1, line.indexOf(token) + 1, ruleId].join('|'));
    lines.push(line);
  }
  for (let routeIndex = 0; routeIndex < routesPerModule; routeIndex++) {
    lines.push(`export async function route${routeIndex}(pool: Pool, ids: string[]) {`,
      "  const selected = ids.map(id => clean(id.trim()).toLowerCase()).filter(Boolean);",
      "  const rows = await pool.query('SELECT id FROM products WHERE id = ANY($1)', [selected]);",
      "  const labels = selected.map(id => clean(id).slice(0, 16)).join(',');");
    if (routeIndex === 0) {
      addFinding("  for (const id of ids) await pool.query('SELECT id FROM products WHERE id = $1', [id]);",
        'query', 'pg-query-in-loop');
      if (usesFilesystem) addFinding("  loadFile('config.txt');", 'loadFile', 'node-sync-fs-in-async');
    }
    lines.push("  return { rows: rows.rows, labels, length: selected.length };", "}");
  }
  files[filename] = lines.join('\n');
}

for (let modelIndex = 0; modelIndex < modelModuleCount; modelIndex++) {
  const properties = Array.from({ length: 90 }, (_, index) => `  field${index}?: string;`);
  files[`model-${modelIndex}.ts`] = ['export interface RecordModel {', ...properties, '}'].join('\n');
}

expected.sort();
const appModuleCount = routeModuleCount + modelModuleCount;
const sourceLines = Object.values(files).reduce((total, source) => total + source.split('\n').length, 0);

function measure() {
  const started = performance.now();
  return withProgram('export {};', files, program => {
    const application = program.getSourceFiles().filter(file => !file.isDeclarationFile);
    program.getTypeChecker();
    const bound = performance.now();
    const findings = application.flatMap(file => analyzeFile(program, file));
    const finished = performance.now();
    const signature = findings.map(({ file, line, column, ruleId }) =>
      [path.basename(file), line, column, ruleId].join('|')).sort();
    assert.deepEqual(signature, expected);
    return { setup: bound - started, analysis: finished - bound, total: finished - started };
  });
}

function median(samples) {
  return [...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)];
}

function benchmarkCli() {
  const fs = require('node:fs');
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'backend-perf-bench-'));
  const bin = path.resolve(__dirname, '../bin/backend-perf-check.cjs');
  const artifacts = { ...files };
  const jsLine = "  for (const id of ids) await pool.query('select id from people where id = $1', [id]);";
  artifacts['service.cjs'] = [
    "/** @param {import('pg').Pool} pool @param {string[]} ids */",
    "module.exports = async function list(pool, ids) {", jsLine, "};",
  ].join('\n');
  const signature = [...expected, ['service.cjs', 3, jsLine.indexOf('query') + 1, 'pg-query-in-loop'].join('|')].sort();
  const rootFiles = Object.keys(artifacts).filter(name => !name.includes('/'));
  const compilerOptions = { target: 'ES2022', module: 'NodeNext', allowJs: true, skipLibCheck: true, types: [] };
  const references = Array.from({ length: 6 }, (_, index) => ({ path: `./service-${index}.json` }));
  for (const [index, reference] of references.entries()) {
    const files = rootFiles.filter((_, fileIndex) => fileIndex % references.length === index);
    artifacts[reference.path] = JSON.stringify({ compilerOptions, files });
  }
  artifacts['all.json'] = JSON.stringify({ compilerOptions, files: rootFiles });
  artifacts['tsconfig.json'] = JSON.stringify({ files: [], references });
  const cliSamples = 5;
  const timings = new Map([['all.json', []], ['tsconfig.json', []]]);
  try {
    for (const [name, content] of Object.entries(artifacts)) {
      const destination = path.join(root, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    }
    for (let sample = 0; sample < cliSamples; sample++) {
      for (const [config, samples] of timings) {
        const started = performance.now();
        const result = spawnSync(process.execPath, [bin, '-p', config, '--json'], { cwd: root, encoding: 'utf8' });
        samples.push(performance.now() - started);
        assert.equal(result.status, 1, result.stderr);
        const { findings, scannedFiles } = JSON.parse(result.stdout);
        assert.equal(scannedFiles, rootFiles.length);
        assert.deepEqual(findings.map(({ file, line, column, ruleId }) => [file, line, column, ruleId].join('|')).sort(), signature);
      }
    }
    console.log(`${rootFiles.length} on-disk modules, ${signature.length} exact findings, ${cliSamples} fresh Node processes per configuration, filesystem cache warm.`);
    for (const [config, samples] of timings) {
      const label = config === 'all.json' ? 'Single project' : 'Six referenced projects';
      console.log(`${label}: median ${median(samples).toFixed(0)} ms (range ${Math.min(...samples).toFixed(0)}–${Math.max(...samples).toFixed(0)} ms)`);
    }
  } finally {
    for (const name of Object.keys(artifacts)) fs.rmSync(path.join(root, name), { force: true });
    for (const directory of ['node_modules/pg', 'node_modules', '.']) {
      const folder = path.join(root, directory);
      if (fs.existsSync(folder)) fs.rmdirSync(folder);
    }
  }
}

if (process.argv.includes('--large')) {
  require('./large.cjs').benchmarkLarge(process.argv.slice(2));
  return;
}
if (process.argv.includes('--cli')) {
  benchmarkCli();
  return;
}

for (let index = 0; index < warmupRuns; index++) measure();
const runs = Array.from({ length: sampleCount }, measure);
console.log(`Node ${process.version}; TypeScript ${require('typescript').version}; ${appModuleCount} synthetic app modules, ${sourceLines} lines including mock pg types, ${expected.length} findings.`);
console.log(`Module load ${moduleLoadMs.toFixed(1)} ms. Medians from ${sampleCount} fresh programs after ${warmupRuns} warmups; exact findings checked every run.`);
for (const [key, name] of [['setup', 'Program creation and binding'], ['analysis', 'Rule analysis'], ['total', 'Total']]) {
  const measurements = runs.map(run => run[key]);
  console.log(`${name}: ${median(measurements).toFixed(1)} ms (range ${Math.min(...measurements).toFixed(1)}–${Math.max(...measurements).toFixed(1)} ms)`);
}
