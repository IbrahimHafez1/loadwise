import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { checkSizeLimits } from '../../lib/maintainability/size-limits.cjs';
import { loadPolicy } from '../../lib/maintainability/project.cjs';
import type { Finding } from '../../lib/shared/types.cjs';
import type { SizeLimits } from '../../lib/maintainability/types/policy.cjs';

function check(source: string, limits?: SizeLimits, file = 'src/example.ts') {
  return checkSizeLimits(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true), file, limits);
}

const ruleIds = (findings: Finding[]) => findings.map((finding: Finding) => finding.ruleId);
const limitsOf = (overrides: Partial<SizeLimits> = {}): SizeLimits => ({
  largeModuleLines: 600,
  largeClassMembers: 30,
  longParameterCount: 5,
  ...overrides,
});

test('large-module counts lines of code, not comments or blank lines', () => {
  const code = Array.from({ length: 10 }, (_, index) => `const value${index} = ${index};`);
  const padded = code.flatMap((line) => [line, '', '// a comment']).join('\n');
  const findings = check(padded, limitsOf({ largeModuleLines: 9 }));
  assert.deepEqual(ruleIds(findings), ['large-module']);
  assert.match(findings[0].message, /10 lines of code \(limit 9/);
  assert.deepEqual(ruleIds(check(code.slice(0, 9).join('\n'), limitsOf({ largeModuleLines: 9 }))), []);
});

test('large-module counts every line of a multi-line statement and template literal', () => {
  const source = 'const text = `a\nb\nc`;\nfunction f() {\n  return 1;\n}';
  assert.deepEqual(ruleIds(check(source, limitsOf({ largeModuleLines: 5 }))), ['large-module']);
});

test('large-class counts methods and accessors but not plain data properties', () => {
  const methods = Array.from({ length: 4 }, (_, index) => `method${index}() {}`).join('\n');
  const fields = Array.from({ length: 10 }, (_, index) => `field${index}: string;`).join('\n');
  const limits = limitsOf({ largeClassMembers: 3 });
  assert.deepEqual(ruleIds(check(`class Service {\n${methods}\n}`, limits)), ['large-class']);
  assert.deepEqual(ruleIds(check(`class Service {\n${fields}\nmethod() {}\n}`, limits)), []);
});

test('long-parameter-list counts positional parameters and treats a destructured object as one', () => {
  assert.deepEqual(ruleIds(check('function send(a, b, c, d, e, f) {}')), ['long-parameter-list']);
  assert.deepEqual(ruleIds(check('const send = (a, b, c, d, e, f, g) => {};')), ['long-parameter-list']);
  assert.deepEqual(ruleIds(check('function send(a, b, c, d, e) {}')), []);
  assert.deepEqual(ruleIds(check('function send({ a, b, c, d, e, f, g }, extra) {}')), []);
  assert.deepEqual(ruleIds(check('declare function send(a, b, c, d, e, f): void;')), []);
});

test('long-parameter-list ignores injection constructors and framework-supplied parameters', () => {
  const injected = '@Injectable() class A { constructor(a: A1, b: B, c: C, d: D, e: E, f: F) {} }';
  const propertyParameters = 'class A { constructor(private a: A1, private b: B, c: C, d: D, e: E, f: F) {} }';
  const handler = 'class A { find(@Param() a, @Query() b, @Body() c, @Req() d, @Res() e, @Headers() f, g) {} }';
  for (const source of [injected, propertyParameters, handler]) assert.deepEqual(ruleIds(check(source)), [], source);
  assert.deepEqual(ruleIds(check('class A { constructor(a, b, c, d, e, f) {} }')), ['long-parameter-list']);
});

test('test files are not checked', () => {
  assert.deepEqual(check('function send(a, b, c, d, e, f) {}', undefined, 'src/example.spec.ts'), []);
});

test('thresholds are configurable and validated in maintainability.config.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-limits-'));
  const configure = (text: string) => fs.writeFileSync(path.join(root, 'maintainability.config.json'), text);
  try {
    assert.deepEqual(loadPolicy(root).limits, limitsOf());
    configure('{"limits":{"longParameterCount":3}}');
    assert.equal(loadPolicy(root).limits.longParameterCount, 3);
    configure('{"limits":{"longParameterCount":0}}');
    assert.throws(() => loadPolicy(root), /positive integer/);
    configure('{"limits":{"unknown":3}}');
    assert.throws(() => loadPolicy(root), /Allowed keys/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
