'use strict';

// Fails when the README's security section, `loadwise sec --help`, the rule registry or the examples drift apart.
const { readRuleTokens } = require('../shared/read-rule-tokens.cjs');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');
const { securityRules, ruleInfo } = require('../../lib/security/rule-ids.cjs');
const { knownRules } = require('../../lib/performance/rule-ids.cjs');
const { exampleFor } = require('../../editor/security-examples.cjs');

const root = path.join(__dirname, '..', '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replaceAll('\r\n', '\n');
const section = readme.slice(readme.indexOf('\n# Security checker\n'), readme.indexOf('\n## Developing locally\n'));
const helpText = spawnSync(process.execPath, [path.join(root, 'bin', 'loadwise.cjs'), 'sec', '--help'], {
  encoding: 'utf8',
}).stdout;
const maxExampleLines = 6;

test('the README has a security section after the maintainability section', () => {
  assert.ok(section.length > 1000, 'missing "# Security checker" before "## Developing locally"');
  assert.ok(readme.indexOf('\n# Maintainability checker\n') < readme.indexOf('\n# Security checker\n'));
});

test('every security rule is documented, registered with its needs and not also a performance rule', () => {
  const documented = readRuleTokens(section);
  assert.deepEqual(
    securityRules.filter((rule) => !documented.has(rule)),
    [],
  );
  for (const rule of securityRules) {
    assert.ok(['syntax', 'import', 'types'].includes(ruleInfo[rule].needs), rule);
    assert.ok(!knownRules.has(rule), `${rule} is registered by both checkers`);
  }
});

test('every rule-like README entry in the section is a security rule', () => {
  const stale = [...readRuleTokens(section)].filter((token) => !securityRules.includes(token));
  assert.deepEqual(stale, []);
});

test('every sec --help flag is in the README', () => {
  const flags = new Set(helpText.match(/--[a-z][a-z-]*/g));
  assert.ok(flags.size > 8, 'could not parse --help');
  assert.deepEqual(
    [...flags].filter((flag) => !section.includes(flag)),
    [],
  );
});

test('every security rule has a short example that parses', () => {
  for (const rule of securityRules) {
    const example = exampleFor(rule, 'typescript');
    assert.ok(example?.code && example.note, `${rule} has no example`);
    assert.ok(example.code.split('\n').length <= maxExampleLines, `${rule} example is too long`);
    // File rules show env, Dockerfile and compose text.
    if (ruleInfo[rule].group === 'files') continue;
    const parsed = ts.createSourceFile('example.ts', example.code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    assert.deepEqual(
      parsed.parseDiagnostics.map(({ messageText }) => messageText),
      [],
      rule,
    );
  }
  assert.equal(exampleFor(securityRules[0], 'python'), undefined);
});
