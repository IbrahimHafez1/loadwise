import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingsOf, defaultFindingsOf } from './exposure-helpers.js';
import { stubs } from './helpers.js';

const ruleId = 'prototype-pollution';
const route = (body: string, preamble = '') =>
  `import express from 'express';\n${preamble}\nconst app = express();\napp.post('/settings', (req, res) => { ${body} });`;

test('a nested write through a request-controlled key is reported', () => {
  const bodies = [
    'const target: any = {}; const [section, field] = Object.keys(req.body); target[section][field] = req.body[field];',
    'const target: any = {}; target[req.body.section].enabled = true;',
    'const target: any = {}; for (const key of Object.keys(req.body)) { target[key][req.body.field] = 1; }',
  ];
  for (const body of bodies) assert.equal(defaultFindingsOf(ruleId, route(body), stubs.express).length, 1, body);
});

test('a single-level write through a request key is contextual', () => {
  const findings = findingsOf(
    ruleId,
    route('const target: any = {}; target[req.body.key] = req.body.value;'),
    stubs.express,
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].contextualReason, 'Sets one own key; pollution needs a nested write.');
});

test('lodash merge, defaultsDeep and path writes with request data are reported', () => {
  const bodies = [
    "import _ from 'lodash';\nconst settings: any = {}; _.merge(settings, req.body);",
    "import { merge } from 'lodash';\nconst settings: any = {}; merge({}, defaults, req.body);",
    "import defaultsDeep from 'lodash/defaultsDeep';\nconst settings: any = {}; defaultsDeep(settings, req.body);",
    "import { set } from 'lodash';\nconst settings: any = {}; set(settings, req.body.path, 1);",
    "import { mergeWith } from 'lodash';\nconst settings: any = {}; mergeWith(settings, req.body, customizer);",
  ];
  for (const body of bodies) {
    const [imports, statement] = body.split('\n');
    const source = `${imports}\ndeclare const defaults: object; declare const customizer: any;\n${route(statement)}`;
    assert.equal(defaultFindingsOf(ruleId, source, stubs.express).length, 1, body);
  }
});

test('a project-local recursive merge that does not guard its keys is reported', () => {
  const merge = [
    'function deepMerge(target: any, source: any) {',
    '  for (const key in source) {',
    "    if (typeof source[key] === 'object') { target[key] = deepMerge(target[key] ?? {}, source[key]); }",
    '    else target[key] = source[key];',
    '  }',
    '  return target;',
    '}',
  ].join('\n');
  assert.equal(defaultFindingsOf(ruleId, route('deepMerge({}, req.body);', merge), stubs.express).length, 1);
  const guarded = merge.replace(
    'for (const key in source) {',
    "for (const key in source) { if (key === '__proto__') continue;",
  );
  assert.equal(findingsOf(ruleId, route('deepMerge({}, req.body);', guarded), stubs.express).length, 0);
});

test('guarded keys, literal keys, safe targets, copies and non-request data are clean', () => {
  const bodies = [
    "const target: any = {}; const key = req.body.key; if (key === '__proto__' || key === 'constructor') return; target[key][1] = 1;",
    'const target: any = {}; target.section[req.body.key] = 1; target["a"]["b"] = req.body.value;',
    'const target = Object.create(null); target[req.body.section][req.body.field] = 1;',
    'const target = new Map<string, any>(); target[req.body.section][req.body.field] = 1;',
    'const copy = { ...req.body }; const merged = Object.assign({}, defaults, req.body);',
    'const target: any = {}; target[config.section][config.field] = 1;',
    'import_.merge(settings, defaults);',
    'merge(settings, req.body);',
    'unrelated(settings, req.body);',
  ];
  for (const body of bodies) {
    const source = route(
      body,
      'declare const defaults: object; declare const config: any; declare const settings: any; declare const import_: any; declare function merge(a: object, b: object): void; declare function unrelated(a: object, b: object): void;',
    );
    assert.equal(defaultFindingsOf(ruleId, source, stubs.express).length, 0, body);
  }
  const lodashWithoutRequest =
    "import { merge } from 'lodash';\ndeclare const a: object; declare const b: object;\nmerge(a, b);";
  assert.equal(findingsOf(ruleId, lodashWithoutRequest).length, 0);
});

test('a walked key path taken from a parameter is contextual unless it checks prototype keys', () => {
  const walker = (guard: string) =>
    [
      'function setKey(target: any, keyPath: string[], value: unknown) {',
      '  let current = target;',
      '  for (let index = 0; index < keyPath.length - 1; index++) { current = current[keyPath[index]]; }',
      `  ${guard}current[keyPath[keyPath.length - 1]] = value;`,
      '}',
    ].join('\n');
  const [finding] = findingsOf(ruleId, walker(''), stubs.express);
  assert.match(finding.contextualReason ?? '', /key path is a function parameter/);
  assert.equal(findingsOf(ruleId, walker("if (keyPath.includes('__proto__')) return; "), stubs.express).length, 0);
  const fixedTarget = 'function set(keyPath: string[]) { const target: any = {}; target[keyPath[0]] = 1; }';
  assert.equal(findingsOf(ruleId, fixedTarget, stubs.express).length, 0);
});
