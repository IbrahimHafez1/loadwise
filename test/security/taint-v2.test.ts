import assert from 'node:assert/strict';
import test from 'node:test';
import { lint } from './helpers.js';
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
