import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPoolTimeout } from '../../lib/reliability/pool-timeout.js';
import { checkUncaughtException } from '../../lib/reliability/uncaught-exception.js';
import { withProgram } from '../performance/helpers.js';
import type { Finding } from '../../lib/shared/types.js';

const pgStub = [
  'export declare class Pool { constructor(config?: object | string); query(sql: string): Promise<unknown>; }',
  'export declare class Client { constructor(config?: object | string); }',
  '',
].join('\n');
const packages = { 'node_modules/pg/index.d.ts': pgStub };

function scanPool(source: string): Finding[] {
  return withProgram(source, packages, (program, sourceFile) =>
    checkPoolTimeout(sourceFile, 'main.ts', program.getTypeChecker()),
  );
}

function scanHandler(source: string): Finding[] {
  return withProgram(source, {}, (program, sourceFile) =>
    checkUncaughtException(sourceFile, 'main.ts', program.getTypeChecker()),
  );
}

test('pool-without-connection-timeout reports a pg Pool or Client with no timeout', () => {
  const sources = [
    "import { Pool } from 'pg';\nexport const pool = new Pool({ max: 10 });",
    "import { Pool } from 'pg';\nexport const pool = new Pool();",
    "import { Client } from 'pg';\nexport const client = new Client('postgres://localhost/db');",
    "import pg from 'pg';\nexport const pool = new pg.Pool({ connectionString: 'x' });",
  ];
  for (const source of sources) {
    const [finding] = scanPool(source);
    assert.equal(finding?.ruleId, 'pool-without-connection-timeout', source);
  }
});

test('pool-without-connection-timeout stays quiet when a timeout is set, hidden or the class is not pg', () => {
  const quiet = [
    "import { Pool } from 'pg';\nexport const pool = new Pool({ connectionTimeoutMillis: 5000 });",
    "import { Pool } from 'pg';\nconst base = { max: 1 };\nexport const pool = new Pool({ ...base });",
    "import { Pool } from 'pg';\nconst config = { max: 1 };\nexport const pool = new Pool(config);",
    "import { Pool } from 'pg';\nconst base = { max: 1 };\nexport const pool = new Pool({ connectionTimeoutMillis: 0, ...base });",
    'class Pool { constructor(public config: object) {} }\nexport const pool = new Pool({ max: 1 });',
  ];
  for (const source of quiet) assert.deepEqual(scanPool(source), [], source);
});

test('uncaught-exception-continues reports a handler that only logs', () => {
  const sources = [
    "process.on('uncaughtException', (error) => { console.error(error); });",
    "function onCrash(error: Error) { console.error(error); }\nprocess.on('uncaughtException', onCrash);",
    "process.once('uncaughtException', function (error) { console.error(error); });",
  ];
  for (const source of sources) {
    const [finding] = scanHandler(source);
    assert.equal(finding?.ruleId, 'uncaught-exception-continues', source);
  }
});

test('uncaught-exception-continues stays quiet when the handler ends the process or cannot be read', () => {
  const quiet = [
    "process.on('uncaughtException', (error) => { console.error(error); process.exit(1); });",
    "process.on('uncaughtException', (error) => { console.error(error); process.exitCode = 1; });",
    "process.on('uncaughtException', (error) => { throw error; });",
    "function shutdown(): void {}\nprocess.on('uncaughtException', () => { shutdown(); });",
    "import { handler } from './elsewhere.js';\nprocess.on('uncaughtException', handler);",
    "process.on('SIGTERM', () => { console.log('bye'); });",
  ];
  for (const source of quiet) assert.deepEqual(scanHandler(source), [], source);
});

test('pool-without-connection-timeout follows import aliases and reads quoted, disabled, overridden and URL options', () => {
  const reported = [
    "import { Pool as PgPool } from 'pg';\nexport const pool = new PgPool({ max: 1 });",
    "import { Pool } from 'pg';\nexport const pool = new Pool({ connectionTimeoutMillis: 0 });",
    "import { Pool } from 'pg';\nexport const pool = new Pool({ connectionTimeoutMillis: undefined });",
    "import { Pool } from 'pg';\nconst base = { max: 1 };\nexport const pool = new Pool({ ...base, connectionTimeoutMillis: 0 });",
    "import { Client } from 'pg';\nexport const client = new Client('postgres://h/db?connectionTimeoutMillis=500');",
    "import { Client } from 'pg';\nexport const client = new Client('postgres://timeout:pw@timeout.example/db?application_name=timeout');",
  ];
  for (const source of reported) {
    assert.equal(scanPool(source)[0]?.ruleId, 'pool-without-connection-timeout', source);
  }
  const quiet = [
    "import { Pool } from 'pg';\nexport const pool = new Pool({ 'connectionTimeoutMillis': 5000 });",
    "import { Pool } from 'pg';\nexport const pool = new Pool({ ['connectionTimeoutMillis']: 5000 });",
  ];
  for (const source of quiet) assert.deepEqual(scanPool(source), [], source);
});

test('uncaught-exception-continues reads prependOnceListener, same-file methods and properties', () => {
  const sources = [
    "process.prependOnceListener('uncaughtException', (error) => { console.error(error); });",
    "const handlers = { crash(error: Error) { console.error(error); } };\nprocess.on('uncaughtException', handlers.crash);",
    "const handlers = { crash: (error: Error) => { console.error(error); } };\nprocess.on('uncaughtException', handlers.crash);",
  ];
  for (const source of sources) {
    assert.equal(scanHandler(source)[0]?.ruleId, 'uncaught-exception-continues', source);
  }
});

test('uncaught-exception-continues needs the process exit code and ignores functions that are never called', () => {
  const reported = [
    "process.on('uncaughtException', (error) => { new Promise(() => { throw error; }).catch(console.error); });",
    "process.on('uncaughtException', (error) => { try { throw error; } finally { return; } });",
    "process.on('uncaughtException', (error) => { try { [error].forEach((value) => { throw value; }); } catch (caught) { console.error(caught); } });",
    "process.on('uncaughtException', (error) => { try { throw error; } catch (caught) { console.error(caught); } });",
    "const state = { exitCode: 0 };\nprocess.on('uncaughtException', (error) => { state.exitCode = 1; console.error(error); });",
    "process.on('uncaughtException', (error) => { const rethrow = () => { throw error; }; console.error(error); });",
  ];
  for (const source of reported) {
    assert.equal(scanHandler(source)[0]?.ruleId, 'uncaught-exception-continues', source);
  }
  const quiet = [
    "process.on('uncaughtException', (error) => { (() => { throw error; })(); });",
    "process.on('uncaughtException', (error) => { try { console.error(error); } finally { throw error; } });",
    "process.on('uncaughtException', (error) => { try { throw error; } catch (caught) { throw caught; } });",
    "process.on('uncaughtException', (error) => { console.error(error); setTimeout(() => process.exit(1), 100); });",
  ];
  for (const source of quiet) assert.deepEqual(scanHandler(source), [], source);
});
