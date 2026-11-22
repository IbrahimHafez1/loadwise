'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { checkCompose } = require('../../lib/security/files/compose.cjs');

const throwawayPassword = 'throwawaySecret42';

test('credentials of a stock datastore container are contextual, whichever side of environment the image is on', () => {
  const imageFirst = `services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: ${throwawayPassword}\n`;
  const imageLast = `services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: ${throwawayPassword}\n    image: bitnami/postgresql:16\n`;
  for (const text of [imageFirst, imageLast]) {
    const findings = checkCompose(text);
    assert.equal(findings.length, 1);
    assert.ok(findings[0].contextualReason);
  }
});

test('a secret on an application service stays a plain finding and does not inherit a neighbour datastore image', () => {
  const text = `services:\n  db:\n    image: postgres:16\n  api:\n    image: my-api\n    environment:\n      JWT_SECRET: ${throwawayPassword}\n`;
  const findings = checkCompose(text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].contextualReason, undefined);
});
