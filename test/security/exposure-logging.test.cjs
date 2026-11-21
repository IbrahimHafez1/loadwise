'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findingsOf, defaultFindingsOf } = require('./exposure-helpers.cjs');
const { withProgram } = require('../performance/helpers.cjs');

const ruleId = 'secret-in-log';
const scope = (statement) =>
  [
    'declare const logger: any; declare const user: any; declare const password: string; declare const token: string;',
    'declare const tokenId: string; declare const tokens: string[]; declare const maxTokens: number;',
    'declare const apiKey: string; declare const passwordLength: number; declare const hasPassword: boolean;',
    'declare const mask: (value: string) => string;',
    `export class Service { private readonly logger: any; run(req: any, dto: any) { ${statement} } }`,
  ].join('\n');

test('secret-named values in logger calls are reported by default', () => {
  const statements = [
    'console.log(password);',
    'console.log("login", token);',
    'this.logger.log(`Reset token ${token}`);',
    'logger.debug("body " + dto.password);',
    'logger.info({ password });',
    'logger.info({ user: user.id, apiKey: user.apiKey });',
    'logger.warn({ password: hashed });',
    'console.error("failed", { authorization: req.headers.authorization });',
    'logger.error(token || "none");',
    'this.logger.verbose(user.accessToken);',
  ];
  for (const statement of statements) {
    const source = scope(statement).replace('declare const mask', 'declare const hashed: string; declare const mask');
    assert.equal(defaultFindingsOf(ruleId, source).length, 1, statement);
  }
});

test('the message names the value', () => {
  const [finding] = findingsOf(ruleId, scope('console.log(dto.refreshToken);'));
  assert.match(finding.message, /^`refreshToken` is written to the log/);
});

test('a whole request body or header object is contextual', () => {
  for (const statement of ['console.log(req.body);', 'logger.info(JSON.stringify(req.headers));']) {
    const findings = findingsOf(ruleId, scope(statement));
    assert.equal(findings.length, 1, statement);
    assert.ok(findings[0].contextualReason, statement);
  }
});

test('metadata names, plurals, literals, masked values, numbers and other receivers are clean', () => {
  const statements = [
    'console.log(tokenId);',
    'console.log(tokens, maxTokens);',
    'logger.info({ passwordLength, hasPassword });',
    'logger.info({ tokenExpiresAt: dto.expiresAt, tokenType: "bearer" });',
    'console.log("invalid password");',
    'console.log(`token missing for ${user.id}`);',
    'console.log(mask(token));',
    'console.log(token.slice(0, 4));',
    'logger.info({ password: "***" });',
    'logger.info({ token: 12 });',
    'console.log(user.password.length);',
    'other.log(password);',
    'save(password);',
    'logger.info(dto.tokenCount);',
  ];
  for (const statement of statements) {
    const source = scope(statement).replace(
      'declare const mask',
      'declare const other: any; declare function save(v: string): void; declare const mask',
    );
    assert.equal(findingsOf(ruleId, source).length, 0, statement);
  }
});

test('a number or boolean typed value is clean even with a secret-like name', () => {
  const source = 'declare const token: number; declare const cookie: boolean;\nconsole.log(token, cookie);';
  assert.equal(findingsOf(ruleId, source).length, 0);
});

test('only a newly generated credential deliberately printed by a CLI command is skipped', () => {
  const source = [
    "import { CommandRunner } from 'nest-commander';",
    'declare const service: { generateApiKeyToken(): Promise<{ token: string }> };',
    'class KeyCommand extends CommandRunner {',
    '  private logger: any;',
    '  async run(receivedToken: { token: string }) {',
    '    const generated = await service.generateApiKeyToken();',
    '    this.logger.log(generated.token);',
    '    this.logger.error(receivedToken.token);',
    '  }',
    '}',
  ].join('\n');
  const filename = 'create-key.command.ts';
  const findings = withProgram('', { [filename]: source }, (program) => {
    const command = program.getSourceFiles().find((file) => file.fileName.endsWith(filename));
    return require('../../lib/security/analyze.cjs')
      .analyzeFile(program, command)
      .filter((finding) => finding.ruleId === ruleId);
  });
  assert.deepEqual(
    findings.map(({ line }) => line),
    [8],
  );
});
