import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingsOf, defaultFindingsOf } from './exposure-helpers.js';

const ruleId = 'nest-validation-without-whitelist';
const withPipe = (expression: string) =>
  `import { ValidationPipe } from '@nestjs/common';\ndeclare const app: any; declare const options: object; declare const flag: boolean;\napp.useGlobalPipes(${expression});`;
const pipeStub = {
  'node_modules/@nestjs/common/index.d.ts': 'export declare class ValidationPipe { constructor(options?: object); }',
};

test('a pipe without whitelist, or with whitelist false, is reported by default', () => {
  const expressions = [
    'new ValidationPipe()',
    'new ValidationPipe({ transform: true })',
    'new ValidationPipe({ whitelist: false })',
    'new ValidationPipe({ forbidNonWhitelisted: true })',
  ];
  for (const expression of expressions) {
    assert.equal(defaultFindingsOf(ruleId, withPipe(expression), pipeStub).length, 1, expression);
  }
});

test('whitelist without forbidNonWhitelisted is contextual', () => {
  const findings = findingsOf(ruleId, withPipe('new ValidationPipe({ whitelist: true })'));
  assert.equal(findings.length, 1);
  assert.ok(findings[0].contextualReason);
});

test('a whitelisting pipe, non-literal options and other classes are clean', () => {
  const clean = [
    'new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })',
    'new ValidationPipe(options)',
    'new ValidationPipe({ ...options })',
    'new ValidationPipe({ whitelist: flag })',
  ];
  for (const expression of clean) assert.equal(findingsOf(ruleId, withPipe(expression)).length, 0, expression);
  const otherPipe = 'declare class ValidationPipe {}\nnew ValidationPipe();';
  assert.equal(findingsOf(ruleId, otherPipe).length, 0);
});
