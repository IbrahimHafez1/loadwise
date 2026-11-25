import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { CliFinding } from '../lib/shared/types/cli-finding.js';
import * as typescript from 'typescript';

const serviceCount = 8;
const groupsPerService = 100;
const modulesPerGroup = 4;
const sourceFileCount = serviceCount * groupsPerService * modulesPerGroup;
const samples = 3;
const bin = path.resolve(import.meta.dirname, '../bin/loadwise.js');

function makeCorpus() {
  const artifacts = new Map<string, string>();
  const expected: string[] = [];
  const compilerOptions = { target: 'ES2022', module: 'NodeNext', allowJs: true, types: [], skipLibCheck: true };
  const references: { path: string }[] = [];
  for (let service = 0; service < serviceCount; service++) {
    const directory = `service-${service}`;
    references.push({ path: `./${directory}` });
    artifacts.set(directory + '/tsconfig.json', JSON.stringify({ compilerOptions, include: ['*.ts', '*.cjs'] }));
    for (let group = 0; group < groupsPerService; group++) {
      const prefix = `${directory}/`;
      const js = group % 25 === 0;
      artifacts.set(
        prefix + `model-${group}.ts`,
        [
          'export interface Customer {',
          '  id: string;',
          '  label: string;',
          '  active: boolean;',
          '}',
          'export interface LookupRequest {',
          '  ids: string[];',
          '  limit: number;',
          '}',
        ].join('\n'),
      );
      artifacts.set(
        prefix + `normalize-${group}.ts`,
        [
          `import type { LookupRequest } from './model-${group}';`,
          'export function normalize(request: LookupRequest) {',
          '  const cleaned = request.ids.map(id => id.trim().toLowerCase()).filter(Boolean);',
          '  const unique = [...new Set(cleaned)];',
          '  return unique.slice(0, request.limit);',
          '}',
        ].join('\n'),
      );
      artifacts.set(
        prefix + `lookup-${group}.ts`,
        [
          "import type { Pool } from 'pg';",
          `import type { Customer } from './model-${group}';`,
          'export async function lookup(pool: Pool, ids: string[]): Promise<Customer[]> {',
          "  return (await pool.query<Customer>('SELECT id, label, active FROM customer WHERE id = ANY($1)', [ids])).rows;",
          '}',
        ].join('\n'),
      );
      const route = prefix + `route-${group}.${js ? 'cjs' : 'ts'}`;
      const lines = js
        ? [
            `const { normalize } = require('./normalize-${group}');`,
            `const { lookup } = require('./lookup-${group}');`,
            `/** @param {import('pg').Pool} pool @param {import('./model-${group}').LookupRequest} request */`,
            'exports.list = async function list(pool, request) {',
          ]
        : [
            "import type { Pool } from 'pg';",
            `import type { LookupRequest } from './model-${group}';`,
            `import { normalize } from './normalize-${group}';`,
            `import { lookup } from './lookup-${group}';`,
            'export async function list(pool: Pool, request: LookupRequest) {',
          ];
      lines.push('  const ids = normalize(request);');
      if (group % 15 === 0 || js) {
        const query = "  for (const id of ids) await pool.query('SELECT id FROM flags WHERE id = $1', [id]);";
        expected.push([route, lines.length + 1, query.indexOf('query') + 1, 'pg-query-in-loop'].join('|'));
        lines.push(query);
      }
      lines.push(
        '  const rows = await lookup(pool, ids);',
        '  return rows.filter(row => row.active).map(row => row.label);',
        '}',
      );
      artifacts.set(route, lines.join('\n'));
    }
  }
  artifacts.set(
    'node_modules/pg/index.d.ts',
    'export declare class Pool { query<Row = unknown>(sql: string, params?: unknown[]): Promise<{rows: Row[]}> }',
  );
  artifacts.set('tsconfig.json', JSON.stringify({ compilerOptions, include: ['service-*/*.ts', 'service-*/*.cjs'] }));
  artifacts.set('solution.json', JSON.stringify({ files: [], references }));
  artifacts.set('peak.cjs', "process.on('exit', () => process.stderr.write(String(process.resourceUsage().maxRSS)));");
  return { artifacts, expected: expected.sort() };
}

function runCli(
  root: string,
  config: string,
  expected: readonly string[],
  native: boolean,
): { ms: number; peakMiB: number } {
  const started = performance.now();
  const flags = native ? ['--native'] : [];
  const result = spawnSync(
    process.execPath,
    ['--require', path.join(root, 'peak.cjs'), bin, 'perf', ...flags, '-p', config, '--json'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const ms = Math.round(performance.now() - started);
  assert.equal(result.status, 1, result.stderr);
  const { findings, scannedFiles }: { findings: CliFinding[]; scannedFiles: number } = JSON.parse(result.stdout);
  assert.equal(scannedFiles, sourceFileCount);
  assert.deepEqual(
    findings.map(({ file, line, column, ruleId }) => [file, line, column, ruleId].join('|')).sort(),
    expected,
  );
  const peakMiB = Math.round(Number(result.stderr) / 1024);
  assert.ok(peakMiB > 0, result.stderr);
  return { ms, peakMiB };
}

function benchmarkLarge(args: readonly string[]): void {
  const { artifacts, expected } = makeCorpus();
  const native = args.includes('--native');
  const reuse = args.indexOf('--reuse');
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = reuse === -1 ? fs.mkdtempSync(path.join(base, 'backend-perf-3200-')) : path.resolve(args[reuse + 1]);
  const written: string[] = [];
  const created = new Set<string>();
  try {
    for (const [name, value] of artifacts) {
      const filename = path.join(root, name);
      if (reuse !== -1) {
        assert.equal(fs.readFileSync(filename, 'utf8'), value, 'Unexpected corpus file ' + name);
      } else {
        const directory = path.dirname(filename);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(filename, value, { flag: 'wx' });
        written.push(filename);
        for (let ancestor = directory; ancestor !== root; ancestor = path.dirname(ancestor)) created.add(ancestor);
      }
    }
    console.log(`Fixture: ${root}`);
    const sourceLines = [...artifacts]
      .filter(([name]) => name.startsWith('service-') && !name.endsWith('.json'))
      .reduce((sum, [, source]) => sum + source.split('\n').length, 0);
    console.log(
      `${sourceFileCount} JS/TS files, ${serviceCount} services, ${sourceLines} source lines, ${expected.length} exact findings. ${process.version}, TypeScript ${typescript.version}, ${os.platform()} ${os.arch()}.`,
    );
    for (const config of ['tsconfig.json', 'solution.json']) {
      const results = Array.from({ length: samples }, () => runCli(root, config, expected, native));
      const median = [...results].sort((left, right) => left.ms - right.ms)[Math.floor(samples / 2)].ms;
      console.log(
        `${config} (${native ? 'native' : 'default'}): ${samples} fresh process times ${results.map((result) => result.ms).join('/')} ms (median ${median} ms), Node process peak RSS ${results.map((result) => result.peakMiB).join('/')} MiB. OS cache is not flushed.`,
      );
    }
  } finally {
    if (reuse === -1 && !args.includes('--keep')) {
      for (const filename of written) fs.unlinkSync(filename);
      for (const dir of [...created].sort((left, right) => right.length - left.length)) fs.rmdirSync(dir);
      fs.rmdirSync(root);
    }
  }
}

export { benchmarkLarge };
