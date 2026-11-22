'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findVulnerabilities } = require('../../lib/security/deps/osv.cjs');
const { withContext, sinkArgument, lintBothWays, stubs } = require('./helpers.cjs');

function cacheDirectory(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-improve-cache-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const record = (id) => ({ id, summary: id, affected: [] });
const answer = (body) => ({ ok: true, status: 200, json: async () => body });

test('an OSV answer that is not JSON or is null fails with the friendly database message', async (context) => {
  const packages = [{ name: 'alpha', version: '1.0.0' }];
  const notJson = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  });
  const nullBody = async () => answer(null);
  for (const fetchImpl of [notJson, nullBody]) {
    await assert.rejects(
      findVulnerabilities(packages, { fetchImpl, cacheDirectory: cacheDirectory(context) }),
      /^Error: The OSV vulnerability database returned an unexpected answer/,
    );
  }
});

