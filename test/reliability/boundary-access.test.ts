// unguarded-boundary-access: nested reads below untyped outside values, and nullable lookups in files the compiler
// does not check for null.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { Node } from 'typescript';
import { ts } from '../../lib/performance/compiler.js';
import { checkBoundaryAccess } from '../../lib/reliability/boundary-access.js';
import fixBuilders from '../../lib/reliability/site-fixes/boundary-access.js';
import type { Finding } from '../../lib/shared/types.js';

const bin = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const ruleId = 'unguarded-boundary-access';
const prelude = [
  'interface Req { body: any; query: any }',
  'declare const users: { id: number; name: string }[];',
  'declare const registry: Map<string, { label: string }>;',
  'declare const document: Document;',
  'declare function validate(value: unknown): void;',
  'declare function respond(status: number): void;',
  '',
].join('\n');

function scratch(context: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-boundary-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function analyze(
  context: TestContext,
  body: string,
  strict: boolean,
  extension = 'ts',
  reportedFile = 'src/handler.ts',
) {
  const directory = scratch(context);
  const file = path.join(directory, `src.${extension}`);
  const text = prelude + body;
  fs.writeFileSync(file, text);
  const program = ts.createProgram([file], {
    strict,
    allowJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
  });
  const sourceFile = program.getSourceFile(file);
  assert.ok(sourceFile);
  const findings = checkBoundaryAccess(sourceFile, reportedFile, program.getTypeChecker());
  return { findings, sourceFile, text };
}

function lineCount(findings: Finding[]): number[] {
  return findings.map((finding) => finding.line ?? 0);
}

function fixed(context: TestContext, body: string, strict = false) {
  const { findings, sourceFile, text } = analyze(context, body, strict);
  assert.equal(findings.length, 1, JSON.stringify(findings));
  const [finding] = findings;
  const offset = sourceFile.getPositionOfLineAndCharacter((finding.line ?? 1) - 1, (finding.column ?? 1) - 1);
  let node: Node | undefined;
  (function visit(candidate: Node): void {
    if (candidate.getStart(sourceFile) <= offset && offset < candidate.end) {
      node = candidate;
      ts.forEachChild(candidate, visit);
    }
  })(sourceFile);
  const result = fixBuilders[ruleId]({ finding, node, sourceFile, text, load: () => null });
  if (!result?.edits) return { result, output: undefined };
  const output = [...result.edits]
    .sort((left, right) => right.start - left.start)
    .reduce((current, edit) => current.slice(0, edit.start) + edit.text + current.slice(edit.end), text);
  return { result, output: output.slice(prelude.length) };
}

test('flags the first nested read below request input, parsed JSON and axios data', (context) => {
  const body = [
    'export function a(req: Req) { return req.body.user.email; }',
    'export function b(raw: string) { return JSON.parse(raw).items.length; }',
    "declare const axios: { get(url: string): Promise<{ data: any }> }; // 'axios' is not installed here",
    "export async function c() { const response = await axios.get('/x'); return response.data.page.total; }",
    'export async function d(res: Response) { const payload = await res.json(); return payload.user.id; }',
    'export function e(req: Req) { const body = req.body; return body.filter.status; }',
    'export function f(ctx: { request: Req }) { return ctx.request.body.tags[0]; }',
  ].join('\n');
  const { findings } = analyze(context, body, true);
  assert.deepEqual(lineCount(findings), [7, 8, 10, 11, 12, 13]);
  assert.ok(findings.every((finding) => finding.ruleId === ruleId));
});

test('flags a Nest body parameter typed any', (context) => {
  const body = [
    'declare function Body(): ParameterDecorator;',
    'export class Controller {',
    '  create(@Body() payload: any) { return payload.profile.name; }',
    '}',
  ].join('\n');
  assert.equal(analyze(context, body, true).findings.length, 1);
});

test('flags nullable lookups used directly when strictNullChecks is off', (context) => {
  const body = [
    'export function a(id: number) { return users.find((user) => user.id === id).name; }',
    "export function b() { const entry = registry.get('k'); return entry.label; }",
  ].join('\n');
  assert.deepEqual(lineCount(analyze(context, body, false).findings), [7, 8]);
});

test('leaves lookups to the compiler when strictNullChecks already reports them', (context) => {
  const body = [
    'export function a(id: number) { return users.find((user) => user.id === id).name; }',
    "export function b() { const entry = registry.get('k'); return entry.label; }",
  ].join('\n');
  assert.deepEqual(analyze(context, body, true).findings, []);
});

test('skips typed input, one-level reads and optional chaining', (context) => {
  const body = [
    'interface Dto { user: { email: string } }',
    'export function typed(req: { body: Dto }) { return req.body.user.email; }',
    'export function shallow(req: Req) { return req.body.user; }',
    'export function optional(req: Req) { return req.body.user?.email; }',
    'export function optionalAbove(req: Req) { return req.body?.user.email; }',
    'export function cast(req: Req) { const dto: Dto = req.body; return dto.user.email; }',
    'export function defaults(req: Req) { const { user = { email: "" } } = req.body; return user.email; }',
    'export function fallback(req: Req) { return (req.body.user ?? { email: "" }).email; }',
    'export function bang(id: number) { return users.find((user) => user.id === id)!.name; }',
  ].join('\n');
  assert.deepEqual(analyze(context, body, false).findings, []);
});

test('skips reads guarded by conditions, early returns and try/catch', (context) => {
  const body = [
    'export function a(req: Req) { if (req.body.user) return req.body.user.email; }',
    'export function b(req: Req) { return req.body.user && req.body.user.email; }',
    'export function c(req: Req) { return req.body.user ? req.body.user.email : ""; }',
    'export function d(req: Req) { if (!req.body.user) { respond(400); return; } return req.body.user.email; }',
    'export function e(req: Req) { try { return req.body.user.email; } catch { return ""; } }',
    'export function f(raw: string) { try { return JSON.parse(raw).items.length; } catch { return 0; } }',
    'export function g(req: Req) { const user = req.body.user; if (!user) throw new Error("x"); return user.email; }',
    'export function h(id: number) { const user = users.find((u) => u.id === id); if (!user) return; return user.name; }',
    'export function i(id: number) { const user = users.find((u) => u.id === id); return user && user.name; }',
  ].join('\n');
  assert.deepEqual(analyze(context, body, false).findings, []);
});

test('skips lookup calls guarded by has, some, includes or the same call', (context) => {
  const body = [
    'export function a(key: string) { if (registry.has(key)) { return registry.get(key).label; } }',
    'export function b(key: string) { return registry.has(key) ? registry.get(key).label : ""; }',
    'export function c(key: string) { if (!registry.has(key)) return; return registry.get(key).label; }',
    'export function d(id: number) { if (users.some((u) => u.id === id)) return users.find((u) => u.id === id).name; }',
    'export function e(key: string) { if (registry.get(key)) return registry.get(key).label; }',
    'export function f(key: string) { return registry.has(key) && registry.get(key).label; }',
  ].join('\n');
  assert.deepEqual(analyze(context, body, false).findings, []);
});

test('a has check on another key does not guard the lookup', (context) => {
  const body =
    'export function a(key: string, other: string) { if (registry.has(other)) { return registry.get(key).label; } }';
  assert.equal(analyze(context, body, false).findings.length, 1);
});

test('skips values checked by a preceding assert, invariant or assert.ok', (context) => {
  const body = [
    'declare function assert(value: unknown): void;',
    'declare namespace assert { function ok(value: unknown): void }',
    'declare function invariant(value: unknown): void;',
    'export function a(id: number) { const user = users.find((u) => u.id === id); assert(user); return user.name; }',
    'export function b(id: number) { const user = users.find((u) => u.id === id); invariant(user, "x"); return user.name; }',
    'export function c(id: number) { const user = users.find((u) => u.id === id); assert.ok(user); return user.name; }',
    'export function d(key: string) { assert(registry.has(key)); return registry.get(key).label; }',
  ].join('\n');
  assert.deepEqual(analyze(context, body, false).findings, []);
});

test('reports one finding per missing value and function', (context) => {
  const body = 'export function a(req: Req) { return [req.body.user.email, req.body.user.name]; }';
  assert.equal(analyze(context, body, true).findings.length, 1);
});

test('skips test files', (context) => {
  const directory = scratch(context);
  const file = path.join(directory, 'src.ts');
  fs.writeFileSync(file, `${prelude}export function a(req: Req) { return req.body.user.email; }`);
  const program = ts.createProgram([file], { noEmit: true, types: [], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'] });
  const sourceFile = program.getSourceFile(file);
  assert.ok(sourceFile);
  assert.deepEqual(checkBoundaryAccess(sourceFile, 'src/handler.test.ts', program.getTypeChecker()), []);
});

test('the fix reads from the first missing level with optional chaining and asks for review', (context) => {
  const { result, output } = fixed(context, 'export function a(req: Req) { return req.body.user.email.trim(); }', true);
  assert.equal(output, 'export function a(req: Req) { return req.body.user?.email.trim(); }');
  assert.equal(result?.requiresReview, true);
  assert.match(result?.note ?? '', /undefined/);
});

test('the fix handles brackets and lookups', (context) => {
  assert.equal(
    fixed(context, 'export function a(req: Req) { return req.body.tags[0]; }', true).output,
    'export function a(req: Req) { return req.body.tags?.[0]; }',
  );
  assert.equal(
    fixed(context, 'export function a(id: number) { const user = users.find((u) => u.id === id); return user.name; }')
      .output,
    'export function a(id: number) { const user = users.find((u) => u.id === id); return user?.name; }',
  );
});

test('no fix is offered for assignment, delete or increment targets', (context) => {
  for (const statement of [
    'req.body.user.email = "x";',
    'delete req.body.user.email;',
    'req.body.user.count++;',
    'req.body.user.items.total += 1;',
  ]) {
    const { result } = fixed(context, `export function a(req: Req) { ${statement} }`, true);
    assert.equal(result, undefined, statement);
  }
});

test('no fix is offered for destructuring assignment targets', (context) => {
  for (const statement of [
    '[req.body.a.b] = list;',
    '({ x: req.body.c.d } = source);',
    '({ ...req.body.e.f } = source);',
    '[...req.body.g.h] = list;',
    'for ([req.body.i.j] of rows) {}',
  ]) {
    const { result } = fixed(
      context,
      `declare const list: unknown[]; declare const source: any; declare const rows: unknown[][]; export function a(req: Req) { ${statement} }`,
      true,
    );
    assert.equal(result, undefined, statement);
  }
});

test('a read inside an array or object literal that is not assigned still gets the fix', (context) => {
  assert.equal(
    fixed(context, 'export function a(req: Req) { return [req.body.user.email]; }', true).output,
    'export function a(req: Req) { return [req.body.user?.email]; }',
  );
});

test('skips lookups guarded by get-or-create, fallback assignment and in-checks', (context) => {
  const body = [
    'export function a(key: string) { if (!registry.has(key)) registry.set(key, { label: "" }); return registry.get(key).label; }',
    'export function b(key: string) { if (!registry.get(key)) { registry.set(key, { label: "" }); } return registry.get(key).label; }',
    'export function c(key: string) { registry.get(key) || registry.set(key, { label: "" }); return registry.get(key).label; }',
    'export function d(req: Req) { req.body.user ??= {}; return req.body.user.email; }',
    'export function e(req: Req) { if (!req.body.user) req.body.user = {}; return req.body.user.email; }',
    "export function f(req: Req) { if (!('user' in req.body)) return; return req.body.user.email; }",
    "export function g(req: Req) { if ('user' in req.body) { return req.body.user.email; } }",
  ].join('\n');
  assert.deepEqual(analyze(context, body, false).findings, []);
});

test('get-or-create on another key or a plain non-exiting check still reports', (context) => {
  const body = [
    'export function a(key: string, other: string) { if (!registry.has(key)) registry.set(other, { label: "" }); return registry.get(key).label; }',
    'export function b(key: string) { if (!registry.has(key)) { respond(404); } return registry.get(key).label; }',
    "export function c(req: Req) { if (!('other' in req.body)) return; return req.body.user.email; }",
  ].join('\n');
  assert.equal(analyze(context, body, false).findings.length, 3);
});

test('rel --json reports the finding through the CLI', (context) => {
  const directory = scratch(context);
  fs.writeFileSync(
    path.join(directory, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', types: [] }, include: ['*.ts'] }),
  );
  fs.writeFileSync(
    path.join(directory, 'handler.ts'),
    'export function handle(req, res) {\n  res.send(req.body.user.email);\n}\n',
  );
  const run = spawnSync(process.execPath, [bin, 'rel', '--json'], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(run.status, 1, run.stderr);
  const report: { findings: Finding[] } = JSON.parse(run.stdout);
  const matches = report.findings.filter((finding) => finding.ruleId === ruleId);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].line, 2);
});

test('does not report DOM lookups, which are not outside input', (context) => {
  const body = "export function c() { const node = document.getElementById('x'); return node.textContent; }";
  assert.deepEqual(analyze(context, body, false).findings, []);
});

test('does not report reads below an import that did not resolve', (context) => {
  const body = [
    "import axios from 'not-installed';",
    "import { handler } from 'also-missing';",
    "export async function a() { const response = await axios.get('/x'); return response.data.page.total; }",
    'export function b() { return handler.body.user.email; }',
  ].join('\n');
  assert.deepEqual(analyze(context, body, true).findings, []);
});

test('skips reads guarded inside the same expression', (context) => {
  const body = [
    'export function a(req: Req) { return req.body.user?.email ?? ""; }',
    'export function b(req: Req) { return req.body.user ? req.body.user.email : ""; }',
    'export function c(req: Req) { return !req.body.user || req.body.user.email; }',
    'export function d(req: Req) { return req.body.user ?? req.body.user.email; }',
  ].join('\n');
  assert.deepEqual(analyze(context, body, false).findings, []);
});

test('does not report a project reading its own package.json or a config file', (context) => {
  const manifest =
    "export function a(raw: string) { return JSON.parse(readFileSync('package.json', 'utf8')).exports.import; }";
  assert.deepEqual(
    analyze(context, `declare function readFileSync(p: string, e: string): string;\n${manifest}`, true).findings,
    [],
  );
  const configBody = 'export function b(req: Req) { return req.body.user.email; }';
  assert.deepEqual(analyze(context, configBody, true, 'ts', 'rollup.config.js').findings, []);
});

test('does not report response data read through a client typed by an unresolved import', (context) => {
  const body = [
    "import { Client } from 'not-installed';",
    'export class Provider {',
    '  private client: Client;',
    "  async send() { const response = await this.client.post('/x'); return response.data.data.uid; }",
    '}',
  ].join('\n');
  assert.deepEqual(analyze(context, body, true).findings, []);
});
