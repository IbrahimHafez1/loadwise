'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { examples, exampleFor } = require('../lib/examples.cjs');

const libDirectory = path.join(__dirname, '..', 'lib');

function reportedRuleIds() {
  const ruleIds = new Set();
  for (const name of fs.readdirSync(libDirectory)) {
    const source = fs.readFileSync(path.join(libDirectory, name), 'utf8');
    for (const match of source.matchAll(/ruleId: '([a-z-]+)'/g)) ruleIds.add(match[1]);
    for (const match of source.matchAll(/report\([^']*?'([a-z-]+)'/g)) ruleIds.add(match[1]);
  }
  return ruleIds;
}

test('every reported ruleId has a compact before/after example', () => {
  const ruleIds = reportedRuleIds();
  assert.ok(ruleIds.size >= 7, 'the scan should find every rule');
  for (const ruleId of ruleIds) {
    const example = exampleFor(ruleId);
    assert.ok(example, ruleId + ' has no example');
    for (const side of [example.before, example.after]) {
      assert.ok(side.length >= 2 && side.length <= 6, ruleId + ' example must be 2-6 lines');
    }
  }
});

test('examples do not describe rules that are never reported', () => {
  const ruleIds = reportedRuleIds();
  for (const ruleId of Object.keys(examples)) assert.ok(ruleIds.has(ruleId), ruleId + ' is not reported');
});
