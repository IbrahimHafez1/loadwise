import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lint } from './helpers.js';
import type { Finding, FixChange } from '../../lib/shared/types.js';
import { fixOf, lineOf, requireText } from '../types/finding-fix.js';
import { reasonOf } from '../types/finding-reason.js';
import type { FileMap } from '../types/project-files.js';
import type * as SiteFixHelpers from './site-fix-helpers.js';

// Loaded on use: these helpers load the bundled compiler, which the native engine run must not.
const loadedSiteFixHelpers =
  process.env.PERF_CHECK_TEST_NATIVE === '1' ? undefined : await import('./site-fix-helpers.js');
const scanWithFixes = (...args: Parameters<typeof SiteFixHelpers.scanWithFixes>) => {
  assert.ok(loadedSiteFixHelpers, 'site-fix-helpers requires the bundled compiler');
  return loadedSiteFixHelpers.scanWithFixes(...args);
};
// Fix tests scan real files on the bundled compiler, which cannot share a process with the native
// one.
const onBundledEngine = { skip: process.env.PERF_CHECK_TEST_NATIVE === '1' };

const fsHeader = [
  'declare const fs: { createReadStream(p: string): any; createWriteStream(p: string): any; readFileSync(p: string, e: string): string };',
  'declare const zlib: { createGzip(): any };',
].join('\n');

function findings(rule: string, source: string, files: FileMap = {}) {
  return lint(source, files).filter((finding: Finding) => finding.ruleId === rule);
}

const pipe = (source: string) => findings('stream-pipe-unhandled-error', `${fsHeader}\n${source}`);
const parse = (source: string) => findings('json-parse-unguarded', source);
const number = (source: string) => findings('request-number-unvalidated', source);

// ---- stream-pipe-unhandled-error ----

test('reports a pipe chain from a file stream without an error handler, once', () => {
  const reported = pipe(
    'export function send(req: any, res: any) {\n  fs.createReadStream("a").pipe(zlib.createGzip()).pipe(res);\n}',
  );
  assert.equal(reported.length, 1);
  assert.equal(reported[0].contextualReason, undefined);
  assert.match(reported[0].message, /pipeline/);
});

test('reports a local stream variable and marks name-only evidence contextual', () => {
  assert.equal(
    pipe(
      'export function copy(p: string) { const file = fs.createReadStream(p); file.pipe(fs.createWriteStream("b")); }',
    ).length,
    1,
  );
  const named = pipe('export function copy(uploadStream: any, target: any) { uploadStream.pipe(target); }');
  assert.equal(named.length, 1);
  assert.ok(named[0].contextualReason);
});

test('stays silent with error handlers, pipeline, finished or unknown receivers', () => {
  const quiet = [
    'export function a(res: any) { const file = fs.createReadStream("a"); file.on("error", () => {}); file.pipe(res); }',
    'export function b(res: any) { fs.createReadStream("a").on("error", () => {}).pipe(res); }',
    'export function c(res: any) { fs.createReadStream("a").pipe(res).on("error", () => {}); }',
    'declare function finished(s: any, cb: any): void;\nexport function d(res: any) { const s = fs.createReadStream("a").pipe(res); finished(s, () => {}); }',
    'export function e(thing: any, other: any) { thing.pipe(other); }',
  ];
  for (const source of quiet) assert.deepEqual(pipe(source), [], source);
});

test('stays silent on RxJS pipes', () => {
  assert.deepEqual(
    pipe(
      "import { map, filter } from 'rxjs/operators';\nexport function f(source$: any) { return source$.pipe(map((x: number) => x), filter(Boolean)); }",
    ),
    [],
  );
  assert.deepEqual(
    pipe(
      'declare function map(fn: any): any;\nexport function g(dataStream: any) { return dataStream.pipe(map((x: number) => x)); }',
    ),
    [],
  );
  assert.deepEqual(
    pipe(
      'declare class Observable<T> { pipe(...ops: any[]): Observable<T> }\ndeclare const op: any;\nexport function h(eventStream: Observable<number>) { eventStream.pipe(op); }',
    ),
    [],
  );
});

test('pipe fix rewrites an async statement chain to await pipeline and adds the import', onBundledEngine, (context) => {
  const { findings: scanned } = scanWithFixes(context, {
    'a.ts': [
      "import fs from 'node:fs';",
      "import zlib from 'node:zlib';",
      'export async function send(req: any, res: any) {',
      "  fs.createReadStream('a').pipe(zlib.createGzip()).pipe(res);",
      '}',
    ].join('\n'),
  });
  const finding = scanned.find((entry) => entry.ruleId === 'stream-pipe-unhandled-error');
  assert.equal(fixOf(finding).requiresReview, true);
  const after = fixOf(finding)
    .changes.map((change: FixChange) => change.after)
    .join('\n');
  assert.match(after, /import \{ pipeline \} from 'node:stream\/promises';/);
  assert.match(after, /await pipeline\(fs\.createReadStream\('a'\), zlib\.createGzip\(\), res\);/);
});

test('pipe fix uses require in CommonJS and skips sync functions', onBundledEngine, (context) => {
  const { findings: scanned } = scanWithFixes(context, {
    'a.cjs': [
      "'use strict';",
      "const fs = require('node:fs');",
      'async function copy(res) {',
      "  fs.createReadStream('a').pipe(res);",
      '}',
      'function syncCopy(res) {',
      "  fs.createReadStream('b').pipe(res);",
      '}',
      'module.exports = { copy, syncCopy };',
    ].join('\n'),
  });
  const reported = scanned.filter((entry) => entry.ruleId === 'stream-pipe-unhandled-error');
  assert.equal(reported.length, 2);
  const [asyncFinding, syncFinding] = reported.sort((left, right) => lineOf(left) - lineOf(right));
  const after = fixOf(asyncFinding)
    .changes.map((change: FixChange) => change.after)
    .join('\n');
  assert.match(after, /const \{ pipeline \} = require\('node:stream\/promises'\);/);
  assert.match(after, /await pipeline\(fs\.createReadStream\('a'\), res\);/);
  assert.equal(syncFinding.fix, undefined);
});

// ---- json-parse-unguarded ----

test('reports JSON.parse of request, message, file and env input outside try', () => {
  const sources = [
    'export async function h(req: any, res: any) { const data = JSON.parse(req.body.payload); res.json(data); }',
    'export async function h(req: any, res: any) { const raw = req.headers["x-meta"]; res.json(JSON.parse(raw)); }',
    'export function onMessage(msg: any) { return JSON.parse(msg.content.toString()); }',
    'declare const fs: any;\nexport function load(p: string) { return JSON.parse(fs.readFileSync(p, "utf8")); }',
    'export async function load(url: string) { const response = await fetch(url); return JSON.parse(await response.text()); }',
    'export function config() { return JSON.parse(process.env.CONFIG ?? "{}"); }',
  ];
  for (const source of sources) assert.equal(parse(`declare const process: any;\n${source}`).length, 1, source);
});

test('marks framework-handled and startup parses contextual', () => {
  const nest = parse(
    'declare function Post(): any; declare function Body(): any;\nexport class C { @Post() create(@Body() body: string) { return JSON.parse(body); } }',
  );
  assert.equal(nest.length, 1);
  assert.ok(nest[0].contextualReason);
  const syncExpress = parse('export function h(req: any, res: any) { res.json(JSON.parse(req.query.filter)); }');
  assert.ok(syncExpress[0].contextualReason);
  const asyncExpress = parse('export async function h(req: any, res: any) { res.json(JSON.parse(req.query.filter)); }');
  assert.equal(asyncExpress[0].contextualReason, undefined);
  const startup = parse(
    'declare const fs: any;\nexport const settings = JSON.parse(fs.readFileSync("s.json", "utf8"));',
  );
  assert.ok(startup[0].contextualReason);
});

test('stays silent on parses in test files', onBundledEngine, (context) => {
  const source =
    'declare const fs: any;\nexport function load(p: string) { return JSON.parse(fs.readFileSync(p, "utf8")); }';
  const { findings: reported } = scanWithFixes(context, { 'loader.ts': source, 'loader.spec.ts': source });
  const files = reported.filter((finding) => finding.ruleId === 'json-parse-unguarded').map((finding) => finding.file);
  assert.equal(files.length, 1);
  assert.match(requireText(files[0]), /loader\.ts$/);
});

test('stays silent inside try/catch and on internal values', () => {
  const quiet = [
    'export async function h(req: any, res: any) { try { res.json(JSON.parse(req.body.payload)); } catch { res.status(400).end(); } }',
    'export function f(text: string) { return JSON.parse(text); }',
    'export function g(cached: string) { const value = JSON.stringify({ a: 1 }); return JSON.parse(value); }',
    'export function k(input: { value: string }) { return JSON.parse(input.value); }',
  ];
  for (const source of quiet) assert.deepEqual(parse(source), [], source);
});

test('stays silent when every caller of the parsing helper catches', () => {
  const header =
    'declare const fs: any;\nfunction load(p: string) { return JSON.parse(fs.readFileSync(p, "utf8")); }\n';
  const guarded = `${header}export function a(p: string) { try { return load(p); } catch { return null; } }`;
  assert.deepEqual(parse(guarded), []);
  const awaited = `${header}export async function a(p: string) { try { return await load(p); } catch { return null; } }`;
  assert.deepEqual(parse(awaited), []);
});

test('still reports a parsing helper with an unguarded, exported or unused caller', () => {
  const header = 'declare const fs: any;\n';
  const body = 'return JSON.parse(fs.readFileSync(p, "utf8")); }';
  const guardedCall = 'export const a = (p: string) => { try { return load(p); } catch {} };';
  const sources = [
    `${header}function load(p: string) { ${body}\n${guardedCall}\nexport const b = (p: string) => load(p);`,
    `${header}export function load(p: string) { ${body}\n${guardedCall}`,
    `${header}function load(p: string) { ${body}\nexport const exposed = { load };`,
    `${header}function load(p: string) { ${body}`,
  ];
  for (const source of sources) assert.equal(parse(source).length, 1, source);
});

test('stays silent on files read from beside the tool, and still reports other paths', () => {
  const header = 'declare const fs: any; declare const path: any; declare const __dirname: string;\n';
  const own = `${header}export function version() { const root = path.resolve(__dirname, "../.."); return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); }`;
  assert.deepEqual(parse(own), []);
  const direct = `${header}export function own() { return JSON.parse(fs.readFileSync(path.join(__dirname, "data.json"), "utf8")); }`;
  assert.deepEqual(parse(direct), []);
  const foreign = `${header}export function foreign(dir: string) { return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); }`;
  assert.equal(parse(foreign).length, 1);
  const uploaded = `${header}export function uploaded(name: string) { return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "uploads", name), "utf8")); }`;
  assert.equal(parse(uploaded).length, 1, 'a variable path part beside import.meta.dirname is still outside input');
});

test('marks a parse of a project-local file contextual, and keeps request-derived paths at default level', () => {
  const header =
    'declare const fs: any; declare const path: any; declare const readFile: any; declare const readdir: any;\n';
  const listed = `${header}export async function h(req: any, res: any) { const files = await readdir("assets/i18n/"); const all = files.map(async (name: string) => { const text = await readFile("assets/i18n/" + name, "utf-8"); return JSON.parse(text); }); res.json(await Promise.all(all)); }`;
  const listedFindings = parse(listed);
  assert.equal(listedFindings.length, 1);
  assert.match(reasonOf(listedFindings[0]), /project's own folder/);
  const literal = `${header}export async function h(req: any, res: any) { res.json(JSON.parse(await readFile("i18n/en.json", "utf-8"))); }`;
  assert.match(reasonOf(parse(literal)[0]), /project's own folder/);
  const cwdBased = `${header}declare const process: any;\nexport function h() { return JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "a.json"), "utf8")); }`;
  assert.match(reasonOf(parse(cwdBased)[0]), /project's own folder/);
  const requestPath = `${header}export async function h(req: any, res: any) { res.json(JSON.parse(await readFile("i18n/" + req.params.name, "utf-8"))); }`;
  assert.equal(parse(requestPath)[0].contextualReason, undefined);
  const requestListing = `${header}export async function h(req: any, res: any) { const files = await readdir(req.query.dir); const all = files.map(async (name: string) => JSON.parse(await readFile("assets/" + name, "utf-8"))); res.json(all); }`;
  assert.equal(parse(requestListing)[0].contextualReason, undefined);
  const parameterPath = `${header}export async function h(req: any, res: any, name: string) { res.json(JSON.parse(await readFile("i18n/" + name, "utf-8"))); }`;
  assert.equal(parse(parameterPath)[0].contextualReason, undefined);
});

test('marks a parse in a standalone script contextual', () => {
  const source = [
    'declare const require: any; declare const module: any; declare const fs: any;',
    'function readJson(file: string) { return JSON.parse(fs.readFileSync(file, "utf8")); }',
    'function main() { readJson("a.json"); }',
    'if (require.main === module) main();',
  ].join('\n');
  const reported = parse(source);
  assert.equal(reported.length, 1);
  assert.match(reasonOf(reported[0]), /operator tooling/);
});

// ---- request-number-unvalidated ----

test('reports request numbers that reach queries, limits, indexes or kept arithmetic', () => {
  const sources = [
    'export async function h(req: any, res: any) { const page = Number(req.query.page); res.json(await db.user.findMany({ skip: page * 20, take: 20 })); }',
    'export function h(req: any, res: any) { res.json(items.slice(0, parseInt(req.query.limit, 10))); }',
    'export function h(req: any, res: any) { res.json(items[Number(req.params.index)]); }',
    'export function h(req: any, res: any) { const qty = parseFloat(req.body.qty); return res.json({ total: qty * 3 }); }',
    'export function h(req: any, res: any) { res.json(items[+req.params.index]); }',
  ];
  for (const source of sources) {
    assert.equal(number(`declare const db: any; declare const items: number[];\n${source}`).length, 1, source);
  }
});

test('stays silent when the number is checked, defaulted or validated', () => {
  const quiet = [
    'export async function h(req: any, res: any) { const page = Number(req.query.page); if (!Number.isFinite(page)) return res.status(400).end(); res.json(await db.user.findMany({ skip: page })); }',
    'export async function h(req: any, res: any) { const limit = Number(req.query.limit); if (limit > 100) return res.status(400).end(); res.json(await db.user.findMany({ take: limit })); }',
    'export function h(req: any, res: any) { res.json(items.slice(0, Number(req.query.limit) || 10)); }',
    'export async function h(req: any, res: any) { const { page } = schema.parse(req.query); res.json(await db.user.findMany({ skip: Number(page) })); }',
    'export function h(req: any, res: any) { const page = Number(req.query.page); res.json({ page }); }',
    'export function notHandler(value: string) { return items.slice(0, Number(value)); }',
  ];
  for (const source of quiet) {
    assert.deepEqual(
      number(`declare const db: any; declare const items: number[]; declare const schema: any;\n${source}`),
      [],
      source,
    );
  }
});

test('number fix inserts a 400 guard after the declaration', onBundledEngine, (context) => {
  const { findings: scanned } = scanWithFixes(context, {
    'a.ts': [
      'declare const db: any;',
      'export async function list(req: any, res: any) {',
      '  const page = Number(req.query.page);',
      '  res.json(await db.user.findMany({ skip: page * 20, take: 20 }));',
      '}',
    ].join('\n'),
  });
  const finding = scanned.find((entry) => entry.ruleId === 'request-number-unvalidated');
  assert.equal(fixOf(finding).requiresReview, true);
  const after = fixOf(finding)
    .changes.map((change: FixChange) => change.after)
    .join('\n');
  assert.match(
    after,
    /const page = Number\(req\.query\.page\);\n\s*if \(!Number\.isFinite\(page\)\) return res\.status\(400\)\.json\(\{ error: 'Invalid page' \}\);/,
  );
});
