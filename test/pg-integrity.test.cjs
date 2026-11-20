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

test('commands assembled entirely from constants are not dynamic query text', () => {
  const findings = lint(
    [
      "import type {Pool, Client} from 'pg';",
      "import {begin} from './commands';",
      'declare const pool: Pool, client: Client, input: string, flag: boolean;',
      "const suffix = '';",
      'pool.query(`${begin}`);',
      "pool.query('BE' + 'GIN');",
      'pool.query(`BEGIN${suffix}`);',
      'pool.query({text: begin});',
      'const join = (one: string, two: string) => one + two;',
      "pool.query(`${join('ROLL', 'BACK')}`);",
      'client.query(`${begin}`);',
      'pool.query(`${begin}; SELECT 1; COMMIT`);',
      'pool.query(`SELECT ${1 + 2}`);',
      "pool.query(`${flag ? 'BEGIN' : 'SELECT 1'}`);",
      'pool.query(`BEGIN ${input}`);',
      'declare const other: {query(sql: string): void};',
      'other.query(begin);',
    ].join('\n'),
    { ...files, 'commands.ts': "export const begin = 'BEGIN';" },
  );
  assert.deepEqual(
    findings.map((item) => [item.ruleId, item.line]),
    [['pg-dynamic-query-text', 15]],
  );
});

test('query configuration follows last-property precedence and custom query implementations stay clean', () => {
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

test('custom Submittables, prototypes and opaque properties on either side of text are outside the pg text contract', () => {
  const findings = lint(
    `import type {Pool} from 'pg';
async function review(pool: Pool, table: string, key: string, submit: () => void) {
  const custom = {submit};
  await pool.query({text: 'BEGIN', submit});
  await pool.query({['submit']: submit, text: 'BEGIN'});
  await pool.query({text: 'SELECT id FROM ' + table, submit() {}});
  await pool.query({__proto__: custom, text: 'BEGIN'});
  await pool.query({text: 'BEGIN', __proto__: custom});
  await pool.query({...custom, text: 'BEGIN'});
  await pool.query({text: 'SELECT id FROM ' + table, ...custom});
  await pool.query({[key]: submit, text: 'BEGIN'});
  await pool.query({text: 'BEGIN', [key]: submit});
  await pool.query({name: 'scope-check', text: 'BEGIN', values: []});
}`,
    files,
  );
  assert.deepEqual(
    findings.map((item) => [item.ruleId, item.line]),
    [],
  );
});
