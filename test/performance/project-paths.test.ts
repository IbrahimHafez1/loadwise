import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { analyzeProgram, analyzeSources } from '../../lib/performance/projects.js';
import { withProgram } from './helpers.js';
import type { Program, SourceFile } from 'typescript';
import type { ProgramAdapter } from '../../lib/shared/types.js';
import { fileOf } from '../types/finding-fix.js';
import * as nativeRuntime from '../../lib/performance/native-runtime.js';

// The JS engine hands the rules a real TypeScript program; `analyzeProgram` needs its root-file
// listing.
function isTypeScriptProgram(program: ProgramAdapter): program is Program {
  return 'getRootFileNames' in program;
}

test('the same logical source passed twice is counted and analyzed once', () => {
  withProgram('async function read() { return 1; }', {}, (program: ProgramAdapter, source: SourceFile) => {
    assert.ok(isTypeScriptProgram(program));
    assert.deepEqual(analyzeProgram({ program, inputs: [source.fileName, source.fileName] }), {
      scannedFiles: 1,
      findings: [],
    });
  });
});

test('one-shot probes see newly installed declarations on the next run', (context) => {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'loadwise-probes-'));
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
  const root = fs.mkdtempSync(path.join(base, 'loadwise-paths-'));
  const files = {
    'shared/check.ts':
      "import {pool} from '../database'; export function check(ids: number[]) { for (const id of ids) pool.query(String(id)); }",
    'local/database.ts': 'export declare const pool: {query(sql: string): void};',
    'live/database.ts': "import type {Pool} from 'pg'; export declare const pool: Pool;",
    'node_modules/pg/index.d.ts': 'export declare class Pool { query(sql: string): void; }',
  };
  const directories = ['shared', 'local', 'live', 'node_modules', 'node_modules/pg'];
  const links: string[] = [];
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
      const linkUnavailable =
        error instanceof Error &&
        'code' in error &&
        typeof error.code === 'string' &&
        ['EPERM', 'ENOSYS', 'EACCES'].includes(error.code);
      if (!linkUnavailable) throw error;
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
  assert.match(fileOf(result.findings[0]), /\/live\/entry\/check\.ts$/);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) return;
  try {
    nativeRuntime.executable();
  } catch {
    return;
  }
  const bin = path.join(import.meta.dirname, '../../bin/loadwise.js');
  const checked = spawnSync(
    process.execPath,
    [bin, 'perf', '--native', '--json', ...links.map((link) => path.join(link, 'check.ts'))],
    { encoding: 'utf8' },
  );
  assert.equal(checked.status, 1, checked.stderr);
  // The CLI adds each rule's fix example, id and fixable flag; everything else must match the
  // library result.
  const printed = JSON.parse(checked.stdout);
  delete printed.engine;
  for (const finding of printed.findings) {
    delete finding.example;
    delete finding.id;
    delete finding.fixable;
    delete finding.impactLevel;
  }
  assert.deepEqual(printed, result);
});
