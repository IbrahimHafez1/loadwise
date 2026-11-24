import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { applyFixes } from '../../lib/performance/fix-cli.cjs';
import { scanWithFixes, requireFix, withSecurity } from '../performance/site-fix-helpers.cjs';

const source = [
  'export const database = {',
  '  host: process.env.DB_HOST,',
  '  // verification is skipped for the self-signed certificate',
  '  ssl: { rejectUnauthorized: false },',
  '};',
  '',
].join('\n');

test('the TLS verification fix is review-only, names the CA prerequisite and never runs under --fix --yes', async (context) => {
  const { findings } = scanWithFixes(context, { 'src/database.config.ts': source }, { analyzers: withSecurity });
  const [finding] = findings.filter(({ ruleId }) => ruleId === 'tls-verification-disabled');
  assert.ok(finding, 'the finding is kept');
  const fix = requireFix(finding);
  assert.equal(fix.requiresReview, true);
  assert.match(fix.note ?? '', /CA certificate \(`ca`\)/);
  assert.ok(finding.file);
  await applyFixes([finding], { all: true });
  assert.equal(fs.readFileSync(finding.file, 'utf8'), source, '--yes leaves the verification option alone');
});
