'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { lint } = require('./helpers.cjs');

const RULE = 'json-parse-unguarded';

const header = [
  'declare const path: { join(...parts: string[]): string };',
  'declare function readFileSync(file: string, encoding: string): string;',
  'declare function readFile(file: string, encoding: string): Promise<string>;',
  'declare const __dirname: string;',
  'declare const cli: { action(callback: (file: string) => void): void };',
].join('\n');

const parseFindings = (source) => lint(`${header}\n${source}`).filter((finding) => finding.ruleId === RULE);

test('marks a parse of a package.json under a runtime directory contextual', () => {
  const reported = parseFindings(
    'export async function read(dir: string) { return JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")); }',
  );
  assert.equal(reported.length, 1);
  assert.match(reported[0].contextualReason, /package\.json/);
});

test('marks a bundled json file with a varying folder contextual', () => {
  const reported = parseFindings(
    'export async function load(lng: string) { return JSON.parse(await readFile(path.join(__dirname, "locales", lng, "translation.json"), "utf8")); }',
  );
  assert.equal(reported.length, 1);
  assert.match(reported[0].contextualReason, /bundled/);
});

test('marks a parse inside a command callback contextual', () => {
  const reported = parseFindings('cli.action((manifest) => { JSON.parse(readFileSync(manifest, "utf8")); });');
  assert.equal(reported.length, 1);
  assert.match(reported[0].contextualReason, /command/);
});

test('marks a json() method that mirrors Response.json contextual', () => {
  const reported = parseFindings(
    'export const wrapper = { async text(): Promise<string> { return ""; }, async json(): Promise<any> { const text = await this.text(); return JSON.parse(text); } };',
  );
  assert.equal(reported.length, 1);
  assert.match(reported[0].contextualReason, /Response\.json/);
});

test('keeps a parse of a caller-chosen file reported without context', () => {
  const reported = parseFindings(
    'export function read(name: string) { return JSON.parse(readFileSync(path.join(__dirname, "uploads", name), "utf8")); }',
  );
  assert.equal(reported.length, 1);
  assert.equal(reported[0].contextualReason, undefined);
});
