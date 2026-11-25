import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { analyzeSources } from '../../lib/performance/projects.js';

test('a file loaded by several configs is read from disk once per run', (context) => {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'backend-perf-reads-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const compilerOptions = { target: 'ES2022', module: 'NodeNext', skipLibCheck: true, types: [] };
  const files = {
    'shared.ts':
      'export declare const pool: {query(sql: string): Promise<void>};\n' +
      'export async function load(ids: number[]) { for (const id of ids) await pool.query(String(id)); }',
    'first.ts': "import {load} from './shared.js'; export const first = load;",
    'second.ts': "import {load} from './shared.js'; export const second = load;",
    'first.json': JSON.stringify({ compilerOptions, files: ['first.ts'] }),
    'second.json': JSON.stringify({ compilerOptions, files: ['second.ts'] }),
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  const shared = path.join(root, 'shared.ts');
  const readFile = ts.sys.readFile;
  let sharedReads = 0;
  ts.sys.readFile = (filename, encoding) => {
    if (path.resolve(filename) === shared) sharedReads += 1;
    return readFile(filename, encoding);
  };
  context.after(() => (ts.sys.readFile = readFile));

  const result = analyzeSources({
    project: [path.join(root, 'first.json'), path.join(root, 'second.json')],
    files: [],
  });

  assert.equal(sharedReads, 1);
  assert.equal(result.scannedFiles, 2);
});
