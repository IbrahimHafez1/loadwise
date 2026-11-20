'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { analyzeProgram, analyzeSources } = require('../lib/projects.cjs');
const { withProgram } = require('./helpers.cjs');

test('the same logical source passed twice is counted and analyzed once', () => {
  withProgram('async function read() { return 1; }', {}, (program, source) => {
    assert.deepEqual(analyzeProgram(program, [source.fileName, source.fileName]), { scannedFiles: 1, findings: [] });
  });
});

test('one-shot probes see newly installed declarations on the next run', (context) => {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'backend-perf-probes-'));
  const source = path.join(root, 'query.ts');
  const modules = path.join(root, 'node_modules');
  const driver = path.join(modules, 'pg');
  const declaration = path.join(driver, 'index.d.ts');
  context.after(() => {
    for (const file of [declaration, source]) if (fs.existsSync(file)) fs.unlinkSync(file);
    for (const directory of [driver, modules, root]) if (fs.existsSync(directory)) fs.rmdirSync(directory);
  });
  fs.writeFileSync(
    source,
    "import type {Pool} from 'pg'; export async function load(pool:Pool, ids:number[]) { for(const id of ids) await pool.query(String(id)); }",
  );
  const scan = () => analyzeSources({ files: [source] }).findings.map((finding) => finding.ruleId);
  assert.deepEqual(scan(), []);
  fs.mkdirSync(driver, { recursive: true });
  fs.writeFileSync(declaration, 'export declare class Pool {query(text:string):Promise<unknown>}');
  assert.deepEqual(scan(), ['pg-query-in-loop']);
});

test('linked entry paths resolve their imports independently', (context) => {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'backend-perf-paths-'));
  const files = {
    'shared/check.ts':
      "import {pool} from '../database'; export function check(ids: number[]) { for (const id of ids) pool.query(String(id)); }",
    'local/database.ts': 'export declare const pool: {query(sql: string): void};',
    'live/database.ts': "import type {Pool} from 'pg'; export declare const pool: Pool;",
    'node_modules/pg/index.d.ts': 'export declare class Pool { query(sql: string): void; }',
  };
  const directories = ['shared', 'local', 'live', 'node_modules', 'node_modules/pg'];
  const links = [];
  context.after(() => {
    for (const link of links) fs.unlinkSync(link);
    for (const filename of Object.keys(files)) fs.rmSync(path.join(root, filename), { force: true });
    for (const directory of directories.reverse()) {
      const folder = path.join(root, directory);
      if (fs.existsSync(folder)) fs.rmdirSync(folder);
    }
    fs.rmdirSync(root);
  });
  for (const directory of directories) fs.mkdirSync(path.join(root, directory));
  for (const [filename, code] of Object.entries(files)) fs.writeFileSync(path.join(root, filename), code);
  for (const folder of ['local', 'live']) {
    const link = path.join(root, folder, 'entry');
    try {
      fs.symlinkSync(path.join(root, 'shared'), link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (!['EPERM', 'ENOSYS', 'EACCES'].includes(error.code)) throw error;
      context.skip('Directory link creation is unavailable on this host');
      return;
    }
    links.push(link);
  }
  const result = analyzeSources({ files: links.map((link) => path.join(link, 'check.ts')) });
  assert.equal(result.scannedFiles, 2);
  assert.deepEqual(
    result.findings.map((finding) => finding.ruleId),
    ['pg-query-in-loop'],
  );
  assert.match(result.findings[0].file, /\/live\/entry\/check\.ts$/);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) return;
  try {
    require('../lib/native-runtime.cjs').executable();
  } catch {
    return;
  }
  const bin = path.join(__dirname, '../bin/backend-perf-check.cjs');
  const checked = spawnSync(
    process.execPath,
    [bin, '--native', '--json', ...links.map((link) => path.join(link, 'check.ts'))],
    { encoding: 'utf8' },
  );
  assert.equal(checked.status, 1, checked.stderr);
  // The CLI adds each rule's fix example, id and fixable flag; everything else must match the library result.
  const printed = JSON.parse(checked.stdout);
  for (const finding of printed.findings) {
    delete finding.example;
    delete finding.id;
    delete finding.fixable;
  }
  assert.deepEqual(printed, result);
});
