'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { scan } = require('../../lib/maintainability/scan.cjs');
const { attachVerifiedPrivateTypes } = require('../../lib/maintainability/verified-private-types.cjs');

async function application(context, extra = {}) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'loadwise-type-proof-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = [
    'export interface ResponseData { value: string }',
    'export function read(): ResponseData { return { value: "ok" }; }',
    'export type Options = { mode: string };',
    'export function consume(options: Options): string { return options.mode; }',
  ].join('\n');
  for (const [name, text] of Object.entries({
    'package.json': '{"private":true}',
    'tsconfig.json': '{"compilerOptions":{"target":"es2022","skipLibCheck":true,"types":[]},"include":["src"]}',
    'src/store.ts': source,
    'src/index.ts':
      'import {read, consume} from "./store"; export class Api { result() { return read(); } } consume({mode:"safe"});',
    ...extra,
  })) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), text);
  }
  const { findings } = await scan(directory, { exclude: [], boundaries: [], placement: [] });
  return { directory, source, findings };
}

test('verifies a batch of private type edits in memory and excludes unnameable declaration returns', async (context) => {
  const { directory, source, findings } = await application(context);
  const candidates = findings.filter((finding) => finding.suggestedRecipe === 'verified-private-types');
  assert.deepEqual(candidates.map((finding) => finding.exportName).sort(), ['Options', 'ResponseData']);
  assert.ok(candidates.every((finding) => !finding.fix));
  attachVerifiedPrivateTypes(findings, directory);
  assert.equal(candidates.find((f) => f.exportName === 'ResponseData').fix, undefined);
  const fix = candidates.find((f) => f.exportName === 'Options').fix;
  assert.equal(fix.requiresReview, true);
  assert.equal(fix.changes[0].after, 'type Options = { mode: string };');
  assert.equal(fs.readFileSync(path.join(directory, 'src/store.ts'), 'utf8'), source);
});

test('an invalid baseline or published package prevents compiler-backed fixes', async (context) => {
  for (const extra of [
    { 'src/broken.ts': 'export const failure: string = 3;' },
    { 'package.json': '{"private":true,"exports":"./src/index.ts"}' },
  ]) {
    const { findings, directory } = await application(context, extra);
    attachVerifiedPrivateTypes(findings, directory);
    assert.ok(!findings.some((finding) => finding.fix));
  }
});
