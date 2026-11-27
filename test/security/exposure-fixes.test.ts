import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanWithFixes, onlyChange, withSecurity } from '../performance/site-fix-helpers.js';
import type { TestContext } from 'node:test';

function fixedFinding(context: TestContext, ruleId: string, source: string) {
  const { findings } = scanWithFixes(context, { 'main.ts': source }, { analyzers: withSecurity });
  return findings.find((finding) => finding.ruleId === ruleId);
}

// Applies the single change of the fix to the source, then scans the result again.
function afterFix(context: TestContext, ruleId: string, source: string) {
  const finding = fixedFinding(context, ruleId, source);
  assert.ok(finding, `${ruleId} reported nothing`);
  const change = onlyChange(finding);
  assert.ok(change, `${ruleId} offered no fix`);
  const lines = source.split('\n');
  assert.ok(finding.fix, `${ruleId} offered no fix`);
  const fixed = finding.fix.changes[0];
  assert.ok(fixed);
  const start = fixed.line - 1;
  const replaced = [...lines.slice(0, start), fixed.after, ...lines.slice(start + fixed.before.split('\n').length)];
  return { finding, fixedSource: replaced.join('\n'), change };
}

test('a missing httpOnly is added to the options literal or as a new argument', (context) => {
  const withOptions = "declare const res: any;\nres.cookie('session', 'x', { secure: true, sameSite: 'lax' });";
  const first = afterFix(context, 'cookie-missing-security-flags', withOptions);
  assert.match(first.fixedSource, /\{ secure: true, sameSite: 'lax', httpOnly: true \}/);
  assert.equal(fixedFinding(context, 'cookie-missing-security-flags', first.fixedSource), undefined);

  const withoutOptions = "declare const res: any;\nres.cookie('session', 'x');";
  const second = afterFix(context, 'cookie-missing-security-flags', withoutOptions);
  assert.match(second.fixedSource, /res\.cookie\('session', 'x', \{ httpOnly: true \}\);/);
  const remaining = fixedFinding(context, 'cookie-missing-security-flags', second.fixedSource);
  assert.ok(remaining);
  assert.ok(remaining.contextualReason, 'secure and sameSite stay for review');
});

test('httpOnly: false and secure: false are not rewritten', (context) => {
  const source = "declare const res: any;\nres.cookie('session', 'x', { httpOnly: false });";
  const finding = fixedFinding(context, 'cookie-missing-security-flags', source);
  assert.ok(finding);
  assert.equal(finding.fix, undefined);
});

test('ValidationPipe gains whitelist: true and the note warns about stripped properties', (context) => {
  const header = "import { ValidationPipe } from '@nestjs/common';\n";
  const cases = [
    ['new ValidationPipe()', 'new ValidationPipe({ whitelist: true })'],
    ['new ValidationPipe({ transform: true })', 'new ValidationPipe({ transform: true, whitelist: true })'],
    ['new ValidationPipe({ whitelist: false })', 'new ValidationPipe({ whitelist: true })'],
  ];
  for (const [before, after] of cases) {
    const result = afterFix(context, 'nest-validation-without-whitelist', `${header}export const pipe = ${before};`);
    assert.ok(result.fixedSource.includes(after), result.fixedSource);
    assert.ok(result.finding.fix);
    assert.match(result.finding.fix.note ?? '', /stripped/);
    assert.equal(result.finding.fix.requiresReview, true);
    const remaining = fixedFinding(context, 'nest-validation-without-whitelist', result.fixedSource);
    assert.ok(!remaining || remaining.contextualReason, before);
  }
});

test('GraphQL introspection follows the environment after the fix', (context) => {
  const source =
    'declare class ApolloServer { constructor(options: object); }\nnew ApolloServer({ introspection: true });';
  const result = afterFix(context, 'graphql-introspection-enabled', source);
  assert.match(result.fixedSource, /introspection: process\.env\.NODE_ENV !== 'production' \}/);
  assert.equal(fixedFinding(context, 'graphql-introspection-enabled', result.fixedSource), undefined);
});

test('a cookie that is not a session or token cookie has no finding to fix', (context) => {
  const source = "declare const res: any;\nres.cookie('theme', 'x');";
  const { findings } = scanWithFixes(context, { 'main.ts': source }, { analyzers: withSecurity });
  assert.equal(findings.filter((finding) => finding.ruleId === 'cookie-missing-security-flags').length, 0);
});
