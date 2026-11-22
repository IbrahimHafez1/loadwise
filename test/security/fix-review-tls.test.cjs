'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { applyFixes } = require('../../lib/performance/fix-cli.cjs');
const { scanWithFixes, withSecurity } = require('../performance/site-fix-helpers.cjs');

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
  assert.equal(finding.fix.requiresReview, true);
  assert.match(finding.fix.note, /CA certificate \(`ca`\)/);
  await applyFixes([finding], { all: true });
  assert.equal(fs.readFileSync(finding.file, 'utf8'), source, '--yes leaves the verification option alone');
});
