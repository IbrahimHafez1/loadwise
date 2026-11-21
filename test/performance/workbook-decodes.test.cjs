'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');

const excelTypes = {
  'node_modules/exceljs/index.d.ts':
    'export class Workbook { xlsx: { load(bytes: Uint8Array, options?: object): Promise<void> } }',
};
const header = "import { Workbook } from 'exceljs';\ntype Upload = { buffer: Uint8Array };\n";
function decodes(source) {
  return lint(header + source, excelTypes).filter(({ ruleId }) => ruleId === 'repeated-workbook-decode');
}

test('same-file readers receiving the same upload may share one ExcelJS decode', () => {
  const findings = decodes(`
class Importer {
  private async images(file: Upload) {
    const rows = new Map();
    try {
      const workbook = new Workbook();
      await workbook.xlsx.load(file.buffer as Uint8Array);
    } catch { return rows; }
    return rows;
  }
  private async variants(file: Upload) {
    const workbook = new Workbook();
    await workbook.xlsx.load(file.buffer);
  }
  async run(file: Upload) {
    const images = await this.images(file);
    if (images.size) { const filename = "images"; }
    await this.variants(file);
  }
}`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /file\.buffer.*share workbook state/);
});

test('plain consecutive decodes and same-file functions are detected', () => {
  assert.equal(
    decodes(`
async function read(bytes: Uint8Array) {
  const workbook = new Workbook();
  await workbook.xlsx.load(bytes);
}
async function run(bytes: Uint8Array) {
  const first = new Workbook();
  await first.xlsx.load(bytes);
  await read(bytes);
  const last = new Workbook();
  await last.xlsx.load(bytes);
}`).length,
    2,
  );
});

test('alternative branches, changed input, load options, guarded helpers and unrelated libraries stay quiet', () => {
  assert.deepEqual(
    decodes(`
async function maybeRead(bytes: Uint8Array) {
  if (bytes.length === 0) return;
  const workbook = new Workbook();
  await workbook.xlsx.load(bytes);
}
async function mutateAndRead(bytes: Uint8Array) {
  const workbook = new Workbook();
  await workbook.xlsx.load(bytes);
  bytes.fill(0);
}
async function run(file: Upload, other: Upload, choose: boolean) {
  const workbook = new Workbook();
  await workbook.xlsx.load(file.buffer);
  file.buffer = other.buffer;
  await workbook.xlsx.load(file.buffer);
  await workbook.xlsx.load(other.buffer);
  await workbook.xlsx.load(other.buffer, { ignoreNodes: [] });
  await maybeRead(other.buffer);
  await mutateAndRead(other.buffer);
  await mutateAndRead(other.buffer);
  if (choose) { await workbook.xlsx.load(other.buffer); } else { await workbook.xlsx.load(other.buffer); }
  const unrelated = { xlsx: { async load(bytes: Uint8Array) {} } };
  await unrelated.xlsx.load(other.buffer);
  await unrelated.xlsx.load(other.buffer);
}`),
    [],
  );
});
