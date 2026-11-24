import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProgram } from '../performance/helpers.cjs';
import { scanWithFixes, assertReportedWithoutFix, withSecurity } from '../performance/site-fix-helpers.cjs';
import { analyzeFile } from '../../lib/security/analyze.cjs';
import { checkSecrets } from '../../lib/security/files/secrets.cjs';
import { checkCompose } from '../../lib/security/files/compose.cjs';
import { stubs } from './helpers.cjs';
import type { SourceFile } from 'typescript';
import type { ProgramAdapter } from '../../lib/shared/types.cjs';

test('development passwords such as testpass are contextual default credentials', () => {
  const [envFinding] = checkSecrets('.env', 'DB_PASSWORD=testpass\n');
  assert.match(envFinding.contextualReason ?? '', /local service/);
  const [urlFinding] = checkSecrets('.env', 'DATABASE_URL=postgres://app:devpassword@localhost:5432/app\n');
  assert.match(urlFinding.contextualReason ?? '', /local service/);
  const [composeFinding] = checkCompose('services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: testpass\n');
  assert.match(composeFinding.contextualReason ?? '', /local service/);
});

test('insecure-random-for-secret offers no randomInt fix for a bound randomInt rejects', (context) => {
  const source = [
    "import { readFileSync } from 'node:fs';",
    'export const resetToken = () => Math.floor(Math.random() * 281474976710656);',
    '',
  ].join('\n');
  const { findings } = scanWithFixes(context, { 'app.ts': source }, { analyzers: withSecurity });
  assertReportedWithoutFix(findings.filter((finding) => finding.ruleId === 'insecure-random-for-secret'));
});

// Symbol lookups made by the security rules for a route with `count` let variables built by `+=`,
// `count` const values and `count` unrelated assignments, each reaching a raw query.
function symbolLookups(count: number) {
  const lines: string[] = [];
  for (let index = 0; index < count; index++) {
    lines.push(`let text${index} = 'SELECT ';`, `text${index} += req.query.column${index};`);
    lines.push(`const value${index} = req.query.value${index};`, `counter = ${index};`);
    lines.push(`prisma.$queryRawUnsafe(text${index});`, `prisma.$queryRawUnsafe('SELECT ' + value${index});`);
  }
  const source = [
    "import express from 'express';",
    'declare const prisma: any;',
    'const app = express();',
    "app.get('/x', (req, res) => {",
    'let counter = 0;',
    ...lines,
    '});',
  ].join('\n');
  return withProgram(source, stubs.express, (program: ProgramAdapter, sourceFile: SourceFile) => {
    const checker = program.getTypeChecker();
    const lookup = checker.getSymbolAtLocation;
    let lookups = 0;
    checker.getSymbolAtLocation = (...args) => {
      lookups++;
      return lookup.apply(checker, args);
    };
    try {
      const findings = analyzeFile(program, sourceFile);
      assert.equal(findings.filter((finding) => finding.ruleId === 'prisma-raw-unsafe-dynamic').length, 2 * count);
    } finally {
      checker.getSymbolAtLocation = lookup;
    }
    return lookups;
  });
}

test('resolving many variables of one function does not rewalk the function for each', () => {
  const smaller = symbolLookups(60);
  const larger = symbolLookups(120);
  // Doubling the function doubles linear work; rewalking the function for each variable quadruples
  // it.
  assert.ok(larger < 2.6 * smaller, `${smaller} lookups for 60 variables, ${larger} for 120`);
});
