import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { withProgram } from './helpers.cjs';
import { checkPasswordHashing } from '../../lib/performance/password-hashing.cjs';
import type { Node, SourceFile } from 'typescript';
import type { Finding, PerformanceRuleContext, ProgramAdapter } from '../../lib/shared/types.cjs';

const bcryptTypes = `
  export function hashSync(data: string, rounds: number): string;
  export function compareSync(data: string, hash: string): boolean;
  export function genSaltSync(rounds?: number): string;
  export function hash(data: string, rounds: number): Promise<string>;
  export function compare(data: string, hash: string): Promise<boolean>;
`;
const files = {
  'node_modules/bcrypt/index.d.ts': bcryptTypes,
  'node_modules/bcryptjs/index.d.ts': bcryptTypes,
  'node_modules/lookalike/index.d.ts': bcryptTypes,
};

function findHashingFindings(source: string) {
  return withProgram(source, files, (program: ProgramAdapter, sourceFile: SourceFile) => {
    const findings: Finding[] = [];
    const context: PerformanceRuleContext = {
      checker: program.getTypeChecker(),
      program,
      strictNullChecks: true,
      verbatimModuleSyntax: false,
      fireAndForgetNames: new Set(),
      isPackageType: () => false,
      isRepeated: () => false,
      report(node: Node, ruleId: string, message: string) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        findings.push({ ruleId, line: line + 1, message });
      },
    };
    (function visit(node: Node): void {
      if (ts.isCallExpression(node)) checkPasswordHashing(node, context);
      ts.forEachChild(node, visit);
    })(sourceFile);
    return findings;
  });
}

test('bcrypt sync calls in async functions report with the async replacement', () => {
  const findings = findHashingFindings(`import * as bcrypt from 'bcrypt';
import * as bcryptjs from 'bcryptjs';
import { hashSync } from 'bcrypt';
async function login(password: string, stored: string) {
  const ok = bcrypt.compareSync(password, stored);
  const hashed = bcryptjs.hashSync(password, 10);
  const salt = bcrypt.genSaltSync(10);
  return [ok, hashed, salt, hashSync(password, 10)];
}`);
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [
      ['password-hash-sync-in-async', 5],
      ['password-hash-sync-in-async', 6],
      ['password-hash-sync-in-async', 7],
      ['password-hash-sync-in-async', 8],
    ],
  );
  assert.equal(
    findings[0].message,
    '`bcrypt.compareSync` blocks the event loop for the whole hash (about 50–100 ms at cost 10), stalling every other request. Use `await bcrypt.compare(password, hash)`.',
  );
  assert.match(findings[1].message, /Use `await bcryptjs\.hash\(password, rounds\)`/);
});

test('request handlers and callbacks nested in async functions report', () => {
  const findings = findHashingFindings(`import * as bcrypt from 'bcrypt';
function handler(req: { body: string }, res: unknown) {
  return bcrypt.hashSync(req.body, 10);
}
async function bulk(passwords: string[]) {
  return passwords.map((password) => bcrypt.hashSync(password, 10));
}`);
  assert.deepEqual(
    findings.map(({ line }) => line),
    [3, 6],
  );
});

test('synchronous startup code, async variants and unrelated packages stay quiet', () => {
  const findings = findHashingFindings(`import * as bcrypt from 'bcrypt';
import * as other from 'lookalike';
export function seedAdmin(password: string) {
  return bcrypt.hashSync(password, 10);
}
async function fine(password: string, stored: string) {
  await bcrypt.compare(password, stored);
  await bcrypt.hash(password, 10);
  return other.compareSync(password, stored);
}`);
  assert.deepEqual(findings, []);
});
