// Fails when the README's security section, `loadwise sec --help`, the rule registry or the
// examples drift apart.
import { readRuleTokens } from '../shared/read-rule-tokens.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { securityRules, polyglotRules, ruleInfo } from '../../lib/security/rule-ids.js';
import { knownRules } from '../../lib/performance/rule-ids.js';
import { exampleFor } from '../../editor/security-examples.cjs';

const root = path.join(import.meta.dirname, '..', '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replaceAll('\r\n', '\n');
const section = readme.slice(readme.indexOf('\n# Security checker\n'), readme.indexOf('\n# Accessibility checker\n'));
const helpText = spawnSync(process.execPath, [path.join(root, 'bin', 'loadwise.js'), 'sec', '--help'], {
  encoding: 'utf8',
}).stdout;
const maxExampleLines = 6;

test('the README has a security section after the maintainability section', () => {
  assert.ok(section.length > 1000, 'missing "# Security checker" before "# Accessibility checker"');
  assert.ok(readme.indexOf('\n# Maintainability checker\n') < readme.indexOf('\n# Security checker\n'));
});

test('every security rule is documented, registered with its needs and not also a performance rule', () => {
  const documented = readRuleTokens(section);
  assert.deepEqual(
    [...securityRules, ...polyglotRules].filter((rule) => !documented.has(rule)),
    [],
  );
  for (const rule of securityRules) {
    assert.ok(['syntax', 'import', 'types'].includes(ruleInfo[rule].needs), rule);
    assert.ok(!knownRules.has(rule), `${rule} is registered by another checker`);
  }
});

test('every rule-like README entry in the section is a security rule', () => {
  const stale = [...readRuleTokens(section)].filter(
    (token) => !securityRules.includes(token) && !polyglotRules.includes(token),
  );
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
    assert.ok(parsed.parseDiagnostics);
    assert.deepEqual(
      parsed.parseDiagnostics.map(({ messageText }) => messageText),
      [],
      rule,
    );
  }
  assert.equal(exampleFor(securityRules[0], 'python'), undefined);
});
