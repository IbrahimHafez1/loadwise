'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lint } = require('./helpers.cjs');

const declarations = `type Input = string | {text: string, values?: unknown[]};
export class Pool {
  query(statement: Input, values?: unknown[]): Promise<unknown>;
  connect(): Promise<PoolClient>;
}
export class Client {query(statement: Input, values?: unknown[]): Promise<unknown>}
export interface PoolClient extends Client {release(): void}`;
const files = { 'node_modules/@types/pg/index.d.ts': declarations };

test('review inline runtime SQL while preserving bound values, literal fragments and SQL tags', () => {
  const findings = lint(
    `import type {Pool, Client} from 'pg';
declare function sql(template: TemplateStringsArray, ...values: unknown[]): { text: string, values: unknown[] };
async function run(pool: Pool, client: Client, id: number, table: string, descending: boolean) {
  await pool.query(\`SELECT id FROM accounts WHERE id = \${id}\`);
  await client.query('SELECT id FROM ' + table);
  await client.query({text: \`SELECT id FROM \${table} WHERE id = $1\`, values: [id]});
  await pool.query('SELECT id FROM accounts WHERE id = $1', [id]);
  await client.query({text: 'SELECT id FROM accounts WHERE id = $1', values: [id]});
  await pool.query(sql\`SELECT id FROM accounts WHERE id = \${id}\`);
  await pool.query('SELECT id ' + 'FROM accounts');
  const literalColumn = 'id';
  await pool.query(\`SELECT \${literalColumn} FROM accounts ORDER BY id \${descending ? 'DESC' : 'ASC'}\`);
  const statement = 'SELECT id FROM accounts WHERE id = $1';
  await pool.query(statement, [id]);
  await pool.query(\`SELECT \${-1}, \${10n}\`);
}`,
    files,
  );
  assert.deepEqual(
    findings.map((item) => [item.ruleId, item.line]),
    [4, 5, 6].map((line) => ['pg-dynamic-query-text', line]),
  );
});

test('trace scalar SQL constants through imports, aliases and fixed formatters', () => {
  const findings = lint(
    [
      "import type {Pool} from 'pg';",
      "import {channel as topic, runtimeValue} from './channels';",
      'declare const pool: Pool, table: string;',
      'const format = (prefix: string, value: string) => `${prefix}_${value}`;',
      "const fixed = format('release', topic);",
      'pool.query(`LISTEN ${fixed}`);',
      'pool.query(`LISTEN ${runtimeValue}`);',
      "pool.query(`LISTEN ${format('release', table)}`);",
      'const external = () => table;',
      'pool.query(`LISTEN ${external()}`);',
      'const cycle: string = cycle;',
      'pool.query(`LISTEN ${cycle}`);',
      'const recursive = (value: string): string => recursive(value);',
      "pool.query(`LISTEN ${recursive('fixed')}`);",
      "const asyncFormat = async () => 'fixed';",
      'pool.query(`LISTEN ${asyncFormat()}`);',
      "const overwrite = (name: string) => (name = table) ? name : 'fixed';",
      "pool.query(`LISTEN ${overwrite('fixed')}`);",
      "const preset = { channel: 'fixed' } as const;",
      'declare function configure(config: { channel: string }): void;',
      'configure(preset);',
      'pool.query(`LISTEN ${preset.channel}`);',
    ].join('\n'),
    {
      ...files,
      'channels.ts':
        "declare function configured(): string; export const channel = 'updates', runtimeValue = configured();",
    },
  );
  assert.deepEqual(
    findings.map((item) => [item.ruleId, item.line]),
    [7, 8, 10, 12, 14, 16, 18, 22].map((line) => ['pg-dynamic-query-text', line]),
  );
});

test('private helper parameters need fixed arguments at every call and no escapes or reassignments', () => {
  const findings = lint(
    [
      "import type {Pool} from 'pg';",
      'export function run(pool: Pool, input: string, forward: (fn: (x:string)=>void)=>void) {',
      '  function fixed(channel: string) { pool.query(`LISTEN ${channel}`); }',
      "  fixed('one'); fixed('two');",
      '  function mixed(channel: string) { pool.query(`LISTEN ${channel}`); }',
      "  mixed('one'); mixed(input);",
      '  function escaped(channel: string) { pool.query(`LISTEN ${channel}`); }',
      "  escaped('one'); forward(escaped);",
      '  function changed(value: string) { value = input; pool.query(`LISTEN ${value}`); }',
      "  changed('one');",
      '  function spread(channel: string) { pool.query(`LISTEN ${channel}`); }',
      '  spread(...[input] as [string]);',
      '  function defaultWrite(channel: string, marker = (channel = input)) { pool.query(`LISTEN ${channel}`); }',
      "  defaultWrite('fixed');",
      '}',
      'export function publicApi(pool: Pool, channel: string) { pool.query(`LISTEN ${channel}`); }',
    ].join('\n'),
    files,
  );
  assert.deepEqual(
    findings.map((item) => [item.ruleId, item.line]),
    [5, 7, 9, 11, 13, 16].map((line) => ['pg-dynamic-query-text', line]),
  );
});

test('an identifier validated by an anchored regex or literal allowlist before the query is not dynamic text', () => {
  const findings = lint(
    [
      "import type {Pool} from 'pg';",
      "const ALLOWED = ['users', 'orders'];",
      "const ALLOWED_SET = new Set(['users']);",
      'const SCHEMA = /^app(?:_test_[a-f0-9]+)?$/;',
      'export async function guarded(pool: Pool, schema: string) {',
      "  if (!/^app(?:_test_[a-f0-9]+)?$/.test(schema)) throw new Error('bad');",
      '  await pool.query(`CREATE SCHEMA "${schema}"`);',
      '}',
      'export async function viaConstant(pool: Pool, schema: string, other: boolean) {',
      '  if (other || !SCHEMA.test(schema)) return;',
      '  await pool.query(`SET search_path TO ${schema}`);',
      '}',
      'export async function allowlist(pool: Pool, table: string, name: string) {',
      '  if (!ALLOWED.includes(table)) throw new Error();',
      '  if (!ALLOWED_SET.has(name)) throw new Error();',
      "  await pool.query('SELECT 1 FROM ' + table + name);",
      '}',
      'export async function inside(pool: Pool, table: string) {',
      '  if (ALLOWED.includes(table)) await pool.query(`SELECT 1 FROM ${table}`);',
      '}',
    ].join('\n'),
    files,
  );
  assert.deepEqual(findings, []);
});

test('a guard that is unanchored, open, non-dominating or bypassed keeps the dynamic text finding', () => {
  const findings = lint(
    [
      "import type {Pool} from 'pg';",
      "const ALLOWED = ['users'];",
      'export async function unanchored(pool: Pool, schema: string) {',
      "  if (!/^app/.test(schema)) throw new Error('bad');",
      '  await pool.query(`CREATE SCHEMA ${schema}`);',
      '}',
      'export async function alternation(pool: Pool, schema: string) {',
      "  if (!/^a|b$/.test(schema)) throw new Error('bad');",
      '  await pool.query(`CREATE SCHEMA ${schema}`);',
      '}',
      'export async function wildcard(pool: Pool, schema: string) {',
      "  if (!/^app.*$/.test(schema)) throw new Error('bad');",
      '  await pool.query(`CREATE SCHEMA ${schema}`);',
      '}',
      'export async function noExit(pool: Pool, schema: string) {',
      '  if (!/^app$/.test(schema)) console.log(schema);',
      '  await pool.query(`CREATE SCHEMA ${schema}`);',
      '}',
      'export async function afterwards(pool: Pool, schema: string) {',
      '  await pool.query(`CREATE SCHEMA ${schema}`);',
      "  if (!/^app$/.test(schema)) throw new Error('bad');",
      '}',
      'export async function reassigned(pool: Pool, schema: string, raw: string) {',
      "  if (!/^app$/.test(schema)) throw new Error('bad');",
      '  schema = raw;',
      '  await pool.query(`CREATE SCHEMA ${schema}`);',
      '}',
      'export async function otherValue(pool: Pool, schema: string, raw: string) {',
      "  if (!/^app$/.test(schema)) throw new Error('bad');",
      '  await pool.query(`CREATE SCHEMA ${schema}.${raw}`);',
      '}',
      'export async function mutableList(pool: Pool, table: string, list: string[]) {',
      '  if (!list.includes(table)) throw new Error();',
      '  await pool.query(`SELECT 1 FROM ${table}`);',
      '}',
    ].join('\n'),
    files,
  );
  assert.deepEqual(
    findings.map((item) => [item.ruleId, item.line]),
    [5, 9, 13, 17, 20, 26, 30, 34].map((line) => ['pg-dynamic-query-text', line]),
  );
});

test('runtime text in an assembled transaction command is dynamic', () => {
  const findings = lint(
    [
      "import type {Pool} from 'pg';",
      'declare const pool: Pool, input: string;',
      "const suffix = '';",
      'pool.query(`BEGIN${suffix}`);',
      'pool.query(`BEGIN ${input}`);',
    ].join('\n'),
    files,
  );
  assert.deepEqual(
    findings.map((item) => [item.ruleId, item.line]),
    [['pg-dynamic-query-text', 5]],
  );
});

test('runtime text in a query configuration is dynamic and custom query implementations stay clean', () => {
  const findings = lint(
    `import type {Pool} from 'pg';
async function run(pool: Pool, table: string, options: {text: string}, optionName: string, fake: {query(text:string): void}) {
  await pool.query({...options, text: 'BEGIN'});
  await pool.query({text: 'BEGIN', ...options});
  await pool.query({...options, text: 'SELECT id FROM ' + table});
  await pool.query({text: 'SELECT id FROM ' + table, [optionName]: 'SELECT 1'});
  await pool.query({text: 'BEGIN', ['text']: 'SELECT 1'});
  fake.query('BEGIN');
  fake.query(\`SELECT id FROM \${table}\`);
  await pool.query({text: 'BEGIN'});
  await pool.query({['text']: 'SELECT id FROM ' + table});
}`,
    files,
  );
  assert.deepEqual(
    findings.map((item) => [item.ruleId, item.line]),
    [['pg-dynamic-query-text', 11]],
  );
});

test('pg dynamic text built only from code-owned constants, config objects and random hex is not reported', () => {
  const source = `import { randomBytes, randomUUID } from 'node:crypto';
    import type { Pool } from 'pg';
    declare const pool: Pool, runtimeName: string, row: { table: string };
    const SIZES = { S: { users: 1_000, name: 'small' }, L: { users: 20_000 } };
    const size = SIZES.L;
    const schema = \`bench_\${randomBytes(8).toString('hex')}\`;
    const run = \`run_\${randomUUID()}\`;
    declare function configure(config: object): void;
    const leaked = { name: 'x' };
    configure(leaked);
    const rewritten = { name: 'x' };
    rewritten.name = runtimeName;
    const uuidOf = (kind: string, n: string) => \`md5('\${kind}-'||\${n})::uuid\`;
    async function setup() {
      await pool.query(\`CREATE SCHEMA "\${schema}"\`);
      await pool.query(\`DROP SCHEMA "\${run}" CASCADE\`);
      await pool.query(\`INSERT INTO t SELECT \${uuidOf('user', 'n')} FROM generate_series(1, \${size.users}) n\`);
      await pool.query(\`SELECT * FROM \${SIZES.S.name}\`);
      await pool.query(\`SELECT * FROM \${runtimeName}\`); // report
      await pool.query(\`SELECT * FROM \${row.table}\`); // report
      await pool.query(\`SELECT * FROM \${randomBytes(8).toString('base64')}\`); // report
      await pool.query(\`SELECT * FROM \${schema.toUpperCase()}\`); // report
      await pool.query(\`SELECT * FROM \${leaked.name}\`); // report
      await pool.query(\`SELECT * FROM \${rewritten.name}\`); // report
    }`;
  const reported = lint(source, files).map((finding) => finding.line);
  const marked = source.split('\n').flatMap((line, index) => (line.endsWith('// report') ? [index + 1] : []));
  assert.deepEqual(reported, marked);
});
