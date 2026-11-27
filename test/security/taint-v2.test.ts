import assert from 'node:assert/strict';
import test from 'node:test';
import { lint, withContext, sinkArgument, stubs } from './helpers.js';
import { ts } from '../../lib/performance/compiler.js';
import { isNumericCall } from '../../lib/security/taint/sanitizers.js';
import type { SourceFile } from 'typescript';
import type { SecurityRuleContext } from '../../lib/shared/types.js';
import type { Finding } from '../../lib/shared/types.js';

function secRules(source: string) {
  return lint(source).map((finding: Finding) => ({
    ruleId: finding.ruleId,
    line: finding.line,
    contextual: Boolean(finding.contextualReason),
  }));
}

test('open-redirect: fixed relative paths with tainted query/hash and allowlist/origin checks are clean', () => {
  const safe = [
    "import express from 'express';",
    'const app = express();',
    'const ALLOWED = ["https://app.example.com"];',
    "app.get('/login', (req, res) => {",
    '  const next = String(req.query.next);',
    '  res.redirect(`/dashboard?next=${encodeURIComponent(next)}`);',
    "  res.redirect('/home#' + next);",
    '  if (ALLOWED.includes(next)) res.redirect(next);',
    '  const parsed = new URL(next, "https://app.example.com");',
    '  if (parsed.origin === "https://app.example.com") res.redirect(next);',
    '});',
  ].join('\n');
  assert.deepEqual(
    secRules(safe).filter((f) => f.ruleId === 'open-redirect'),
    [],
  );
});

test('path-traversal: slash regex guard and path.resolve(base) prefix check are clean', () => {
  const safe = [
    "import express from 'express';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    'const app = express();',
    "const base = path.resolve('/srv/uploads');",
    "app.get('/file', (req, res) => {",
    '  const name = String(req.query.name);',
    '  if (/[/\\\\]/.test(name)) return res.status(400).end();',
    '  const target = path.resolve(base, name);',
    '  if (!target.startsWith(path.resolve(base) + path.sep)) return res.status(403).end();',
    '  fs.readFileSync(target);',
    '});',
  ].join('\n');
  assert.deepEqual(
    secRules(safe).filter((f) => f.ruleId === 'path-traversal'),
    [],
  );
});

test('taint engine: tracks 3-hop propagation, object spread, Object.assign, Promise.resolve, and array map', () => {
  const code = [
    "import express from 'express';",
    "import { exec } from 'node:child_process';",
    'const app = express();',
    'function hop3(v: string) { exec(v); }',
    'function hop2(v: string) { hop3(v); }',
    'function hop1(v: string) { hop2(v); }',
    "app.post('/run', async (req, res) => {",
    '  const spread = { ...req.body };',
    '  const assigned = Object.assign({}, spread);',
    '  const resolved = await Promise.resolve(assigned.cmd);',
    '  const mapped = [resolved].map((x) => x).join("");',
    '  hop1(mapped);',
    '  res.end();',
    '});',
  ].join('\n');
  const findings = secRules(code).filter((f) => f.ruleId === 'command-injection');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 4);
});

test('taint sources: recognizes h3, GraphQL resolver args, and Socket.IO/ws handlers', () => {
  const code = [
    "import { exec } from 'node:child_process';",
    "import { readBody } from 'h3';",
    'export const resolvers = {',
    '  Mutation: {',
    '    runTool: (_parent: unknown, args: { cmd: string }) => {',
    '      exec(args.cmd);',
    '    },',
    '  },',
    '};',
    'export function setupSocket(socket: { on(ev: string, fn: (data: string) => void): void }) {',
    "  socket.on('cmd', (data) => { exec(data); });",
    '}',
    'export async function h3Handler(event: unknown) {',
    '  const body = await readBody(event);',
    '  exec(body.cmd);',
    '}',
  ].join('\n');
  const findings = secRules(code).filter((f) => f.ruleId === 'command-injection');
  assert.deepEqual(
    findings.map((f) => f.line),
    [6, 11, 15],
  );
});

function routeLines(body: string, ruleId: string, preamble: string[] = []) {
  const source = [
    "import express from 'express';",
    "import { exec } from 'node:child_process';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    ...preamble,
    'const app = express();',
    `app.get('/run', (req, res) => { ${body} });`,
  ].join('\n');
  return secRules(source)
    .filter((finding) => finding.ruleId === ruleId)
    .map((finding) => finding.line);
}

test('a local Number shadow does not make Number.isInteger a guard', () => {
  const shadowed = 'const Number = { isInteger: (_value: unknown) => true }; const cmd = String(req.query.cmd);';
  assert.equal(routeLines(`${shadowed} if (!Number.isInteger(cmd)) return; exec(cmd);`, 'command-injection').length, 1);
  assert.equal(
    routeLines('const cmd = String(req.query.cmd); if (!Number.isInteger(cmd)) return; exec(cmd);', 'command-injection')
      .length,
    0,
  );
});

test('logical assignments carry request data into a later sink', () => {
  for (const operator of ['||=', '??=', '&&=']) {
    const body = `let cmd = ''; cmd ${operator} String(req.query.cmd); exec(cmd);`;
    assert.equal(routeLines(body, 'command-injection').length, 1, operator);
  }
});

test('a map callback that reads the array argument keeps the receiver taint', () => {
  const read = 'exec(req.body.items.map((_item: string, index: number, all: string[]) => all[index]).join(","));';
  assert.equal(routeLines(read, 'command-injection').length, 1);
  const placeholders = 'exec(req.body.items.map((_item: string, index: number) => "$" + index).join(","));';
  assert.equal(routeLines(placeholders, 'command-injection').length, 0);
});

test('a negated character class holding a slash does not prove a file name has no separator', () => {
  const negated =
    'const name = String(req.query.name); if (/[^a-z/]/.test(name)) return; fs.readFileSync(path.join("/srv", name));';
  assert.equal(routeLines(negated, 'path-traversal').length, 1);
  const positive =
    'const name = String(req.query.name); if (/[/\\]/.test(name)) return; fs.readFileSync(path.join("/srv", name));';
  assert.equal(routeLines(positive, 'path-traversal').length, 0);
});

test('an allowlist guard on an outer binding does not cover a shadowing inner binding', () => {
  const body =
    'const label = String(req.query.l); if (ALLOWED.includes(label)) { const label = String(req.query.x); exec(label); }';
  assert.equal(routeLines(body, 'command-injection', ["const ALLOWED = ['a', 'b'];"]).length, 1);
  const same = 'const label = String(req.query.l); if (ALLOWED.includes(label)) { exec(label); }';
  assert.equal(routeLines(same, 'command-injection', ["const ALLOWED = ['a', 'b'];"]).length, 0);
});

function urlControlOf(body: string) {
  const source = [
    "import express from 'express';",
    'declare function sink(value: unknown): void;',
    'const app = express();',
    `app.get('/go', (req, res) => { ${body} });`,
  ].join('\n');
  return withContext(source, stubs.express, (context: SecurityRuleContext, sourceFile: SourceFile) =>
    context.taint.urlControl(sinkArgument(sourceFile)),
  );
}

test('urlControl keeps the trace of a value built with += after a single plain assignment', () => {
  const control = urlControlOf("let target = ''; target = 'https://'; target += String(req.query.host); sink(target);");
  assert.equal(control?.part, 'whole');
});

test('urlControl reads adjacent literals as one origin before choosing between input and base', () => {
  const control = urlControlOf(
    "const target = new URL('https://' + 'example.test/' + String(req.query.segment), String(req.query.base)); sink(target);",
  );
  assert.equal(control?.part, 'path');
  const relative = urlControlOf(
    "const target = new URL('items/' + String(req.query.segment), String(req.query.base)); sink(target);",
  );
  assert.equal(relative?.part, 'whole');
});

test('JSON.parse of a whole request body stays an operator object for a Mongo filter', () => {
  const source = (body: string) =>
    [
      "import express from 'express';",
      "import mongoose from 'mongoose';",
      "const User = mongoose.model('User', {});",
      'const app = express();',
      `app.post('/find', async (req, res) => { ${body} });`,
    ].join('\n');
  const files = {
    'node_modules/mongoose/index.d.ts': [
      'export interface Model<T> { find(filter?: object): unknown }',
      'declare const mongoose: { model(name: string, schema?: unknown): Model<unknown> }; export default mongoose;',
    ].join('\n'),
  };
  const nosqlFindings = (body: string) =>
    lint(source(body), { ...stubs.express, ...files }).filter(
      (finding: Finding) => finding.ruleId === 'nosql-operator-injection',
    );
  assert.equal(nosqlFindings('await User.find(JSON.parse(req.body));').length, 1);
  assert.equal(nosqlFindings('await User.find({ name: String(req.body.name) });').length, 0);
});

test('a shadowed numeric helper is not a numeric sanitizer', () => {
  const isNumeric = (source: string) =>
    withContext(source, {}, (context: SecurityRuleContext, sourceFile: SourceFile) => {
      const call = sinkArgument(sourceFile);
      return ts.isCallExpression(call) && isNumericCall(call, context.checker);
    });
  const declaration = 'declare function sink(value: unknown): void; declare const raw: string;';
  assert.equal(isNumeric(`${declaration} sink(parseInt(raw));`), true);
  assert.equal(isNumeric(`${declaration} sink(Number.parseFloat(raw));`), true);
  assert.equal(isNumeric(`${declaration} const parseInt = (value: string) => value; sink(parseInt(raw));`), false);
  assert.equal(
    isNumeric(`${declaration} const Math = { floor: (value: string) => value }; sink(Math.floor(raw));`),
    false,
  );
});
