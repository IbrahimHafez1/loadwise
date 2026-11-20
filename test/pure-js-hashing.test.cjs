'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { lint } = require('./helpers.cjs');
const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

const bcryptjsTypes = `
  export function hash(data: string, rounds: number | string): Promise<string>;
  export function compare(data: string, hash: string): Promise<boolean>;
  export function genSalt(rounds?: number): Promise<string>;
  export function hashSync(data: string, rounds: number): string;
`;
const files = { 'node_modules/bcryptjs/index.d.ts': bcryptjsTypes, 'node_modules/bcrypt/index.d.ts': bcryptjsTypes };

function check(source) {
  return lint(source, files).filter((finding) => finding.ruleId === 'password-hash-pure-js');
}

test('reports once per file at the first bcryptjs hash and resolves a const cost', () => {
  const findings = check(
    [
      "import { hash, compare } from 'bcryptjs';",
      'const ROUNDS = 12;',
      'export async function login(password: string, stored: string) {',
      '  const ok = await compare(password, stored);',
      '  return ok ? await hash(password, ROUNDS) : null;',
      '}',
      'export async function register(password: string) {',
      '  return hash(password, ROUNDS);',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 4);
  assert.match(findings[0].message, /cost 12/);
});

test('ignores sync variants and native bcrypt', () => {
  assert.equal(check("import { hashSync } from 'bcryptjs';\nhashSync('a', 10);").length, 0);
  assert.equal(check("import { hash } from 'bcrypt';\nexport const run = () => hash('a', 10);").length, 0);
});

test('site fix swaps the import specifier for compatible import shapes only', (context) => {
  const { findings } = scanWithFixes(context, {
    ...files,
    'package.json': JSON.stringify({ dependencies: { bcrypt: '^6.0.0', bcryptjs: '^2.4.3' } }),
    'a.ts': "import * as bcrypt from 'bcryptjs';\nexport const a = () => bcrypt.hash('p', 10);\n",
    'b.ts': "import { hash, hashSync } from 'bcryptjs';\nexport const b = () => hash('p', 10) && hashSync('p', 10);\n",
  });
  const byFile = (name) =>
    findings.find((finding) => finding.ruleId === 'password-hash-pure-js' && finding.file.endsWith(name));
  assert.deepEqual(onlyChange(byFile('a.ts')), {
    before: "import * as bcrypt from 'bcryptjs';",
    after: "import * as bcrypt from 'bcrypt';",
  });
  assert.match(byFile('a.ts').fix.note, /@types\/bcrypt/);
  assert.equal(byFile('b.ts').fix, undefined);
});

test('site fix offers no edit while bcrypt is missing from package.json', (context) => {
  const { findings } = scanWithFixes(context, {
    'node_modules/bcryptjs/index.d.ts': bcryptjsTypes,
    'package.json': JSON.stringify({ dependencies: { bcryptjs: '^2.4.3' } }),
    'a.ts': "import { hash } from 'bcryptjs';\nexport const a = () => hash('p', 10);\n",
  });
  const finding = findings.find((candidate) => candidate.ruleId === 'password-hash-pure-js');
  assert.ok(finding);
  assert.equal(finding.fix, undefined);
});
