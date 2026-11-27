// One minimal sample per reliability fix builder, taken from the rule's own detectors.
import { anyNodeModules } from './package-stubs.js';
import type { FixVerificationCase } from '../../../types/fix-verification.js';
import type { FileMap } from '../../../types/project-files.js';

const packageManifest = JSON.stringify({ private: true, type: 'module' });

function sample(ruleId: string, files: FileMap): FixVerificationCase {
  return { ruleId, files: { 'package.json': packageManifest, ...files } };
}

// The comparison rules against NaN and typeof only read unchecked JavaScript; the compiler already
// reports them in TypeScript.
const nanComparison = [
  'export function parseCount(text) {',
  '  const value = Number(text);',
  '  if (value === NaN) return 0;',
  '  return value;',
  '}',
  '',
].join('\n');

const typeofTypo = [
  'export function describe(value) {',
  "  if (typeof value === 'strng') return 'text';",
  "  return 'other';",
  '}',
  '',
].join('\n');

const assignmentInCondition = [
  'export function pickLimit(mode: string) {',
  "  if (mode = 'fast') {",
  '    return 10;',
  '  }',
  '  return 1;',
  '}',
  '',
].join('\n');

const unreachableCode = [
  'export function status(): string {',
  "  return 'ready';",
  "  console.log('never printed');",
  '}',
  '',
].join('\n');

const loopPastLength = [
  'export function sum(values: number[]): number {',
  '  let total = 0;',
  '  for (let index = 0; index <= values.length; index++) {',
  '    total += values[index];',
  '  }',
  '  return total;',
  '}',
  '',
].join('\n');

// Two levels into untyped request input: the compiler cannot warn when `user` is missing.
const boundaryAccess = ['export function emailOf(req: any) {', '  return req.body.user.email;', '}', ''].join('\n');

const fileHandleLeak = [
  "import { open } from 'node:fs/promises';",
  '',
  'export async function readAll(file: string) {',
  "  const handle = await open(file, 'r');",
  "  const contents = await handle.readFile('utf8');",
  '  return contents;',
  '}',
  '',
].join('\n');

const typeormStub = {
  'node_modules/typeorm/index.d.ts': [
    'export interface QueryRunner {',
    '  connect(): Promise<void>;',
    '  release(): Promise<void>;',
    '  query(statement: string): Promise<unknown>;',
    '}',
    'export declare class DataSource {',
    '  createQueryRunner(): QueryRunner;',
    '}',
    '',
  ].join('\n'),
};

const queryRunnerLeak = [
  "import { DataSource } from 'typeorm';",
  '',
  'export async function countRows(source: DataSource) {',
  '  const runner = source.createQueryRunner();',
  '  await runner.connect();',
  "  const rows = await runner.query('SELECT 1');",
  '  return rows;',
  '}',
  '',
].join('\n');

const puppeteerStub = {
  'node_modules/puppeteer/index.d.ts': [
    'export interface Page {',
    '  goto(url: string): Promise<void>;',
    '  title(): Promise<string>;',
    '}',
    'export interface Browser {',
    '  newPage(): Promise<Page>;',
    '  close(): Promise<void>;',
    '}',
    'export declare function launch(): Promise<Browser>;',
    '',
  ].join('\n'),
};

const browserLeak = [
  "import { launch } from 'puppeteer';",
  '',
  'export async function titleOf(url: string) {',
  '  const browser = await launch();',
  '  const page = await browser.newPage();',
  '  await page.goto(url);',
  '  const title = await page.title();',
  '  return title;',
  '}',
  '',
].join('\n');

const reliabilityCases: FixVerificationCase[] = [
  sample('assignment-in-condition', { 'limits.ts': assignmentInCondition }),
  sample('nan-comparison', { 'count.js': nanComparison }),
  sample('invalid-typeof-comparison', { 'describe.js': typeofTypo }),
  sample('unreachable-code', { 'status.ts': unreachableCode }),
  sample('loop-index-past-length', { 'sum.ts': loopPastLength }),
  sample('unguarded-boundary-access', { 'email.ts': boundaryAccess }),
  sample('file-handle-not-closed', { 'read.ts': fileHandleLeak, ...anyNodeModules }),
  // The stub has no package.json, so the project must not be an ES module package: Node's ESM
  // resolution would not find its index.d.ts.
  sample('query-runner-not-released', { 'rows.ts': queryRunnerLeak, ...typeormStub, 'package.json': '{}' }),
  sample('browser-not-closed', { 'title.ts': browserLeak, ...puppeteerStub }),
];

export { reliabilityCases };
