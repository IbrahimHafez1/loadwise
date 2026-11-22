'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withProgram } = require('../performance/helpers.cjs');
const { scanWithFixes, assertReportedWithoutFix, withSecurity } = require('../performance/site-fix-helpers.cjs');
const { analyzeFile } = require('../../lib/security/analyze.cjs');
const { checkSecrets } = require('../../lib/security/files/secrets.cjs');
const { checkCompose } = require('../../lib/security/files/compose.cjs');
const { stubs } = require('./helpers.cjs');

test('development passwords such as testpass are contextual default credentials', () => {
  const [envFinding] = checkSecrets('.env', 'DB_PASSWORD=testpass\n');
  assert.match(envFinding.contextualReason, /local service/);
  const [urlFinding] = checkSecrets('.env', 'DATABASE_URL=postgres://app:devpassword@localhost:5432/app\n');
  assert.match(urlFinding.contextualReason, /local service/);
  const [composeFinding] = checkCompose('services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: testpass\n');
  assert.match(composeFinding.contextualReason, /local service/);
});
