import assert from 'node:assert/strict';
import test from 'node:test';
import { checkChildProcesses } from '../../lib/reliability/child-process.js';
import { checkErrorValues } from '../../lib/reliability/error-values.js';
import { withProgram } from '../performance/helpers.js';

const noPackages = {};

function childProcessRules(source: string): string[] {
  return withProgram(source, noPackages, (program, sourceFile) =>
    checkChildProcesses(sourceFile, 'main.ts', program.getTypeChecker()).map(({ ruleId }) => ruleId),
  );
}

function errorRules(source: string): string[] {
  return withProgram(source, noPackages, (_program, sourceFile) =>
    checkErrorValues(sourceFile, 'main.ts').map(({ ruleId }) => ruleId),
  );
}

const spawnImport = "import { spawn, fork, exec, execFile } from 'node:child_process';\n";
const flagged = ['child-process-without-error-listener'];

test('child-process-without-error-listener reports spawned processes that only get other listeners', () => {
  const sources = [
    "spawn('ls');",
    "spawn('ls', ['-l']).unref();",
    "const child = spawn('ls');\nchild.on('close', () => {});",
    "const child = fork('worker.js');\nchild.stdout?.on('data', () => {});\nchild.kill();",
    "const child = exec('ls');\nchild.on('exit', () => {});",
    "const file = '/missing';\nexecFile(file);",
    "const child = spawn('ls');\nchild.on('close', onClose).on('exit', onExit);",
    "function run() { const child = spawn('ls'); return new Promise((resolve) => child.on('close', resolve)); }",
  ];
  for (const source of sources) assert.deepEqual(childProcessRules(spawnImport + source), flagged, source);
});

test('child-process-without-error-listener resolves namespace, default and required imports', () => {
  const sources = [
    "import * as cp from 'child_process';\ncp.spawn('ls');",
    "import cp from 'node:child_process';\ncp.spawn('ls');",
    "const { spawn } = require('child_process');\nspawn('ls');",
  ];
  for (const source of sources) assert.deepEqual(childProcessRules(source), flagged, source);
});

test('child-process-without-error-listener accepts handled, handed-off and callback forms', () => {
  const sources = [
    "const child = spawn('ls');\nchild.on('error', () => {});\nchild.on('close', () => {});",
    "const child = spawn('ls');\nchild.once('error', () => {});",
    "spawn('ls').on('error', () => {});",
    "const child = spawn('ls');\nchild.on(eventName, () => {});",
    "const child = spawn('ls');\nawait once(child, 'exit');",
    "function start() { return spawn('ls'); }",
    "const child = spawn('ls');\nregister(child);",
    "const child = spawn('ls');\nthis.child = child;",
    "const { stdout } = spawn('ls');",
    "exec('ls', (error) => {});",
    "exec('ls', callback);",
    "const child = spawn('ls');\nchild.on('close', onClose).on('error', onError);",
    "const child = spawn('ls');\nreturn child;",
    "const child = spawn('ls');\nregister(child.on('close', onClose));",
    "const child = spawn('ls');\nconst forwarded = child.on('close', onClose);\nregister(forwarded);",
  ];
  for (const source of sources) assert.deepEqual(childProcessRules(spawnImport + source), [], source);
});

test('child-process-without-error-listener ignores a local spawn and other modules', () => {
  assert.deepEqual(childProcessRules("function spawn(name: string) {}\nspawn('ls');"), []);
  assert.deepEqual(childProcessRules("import { spawn } from 'cross-spawn';\nspawn('ls');"), []);
});

test('error-rethrown-without-cause reports a new error that drops the caught one', () => {
  const sources = [
    "try { work(); } catch (err) { throw new Error('work failed'); }",
    "try { work(); } catch (err) { throw (new Error('work failed')); }",
    'try { work(); } catch (error) { throw new TypeError(`bad config ${path}`); }',
    "try { work(); } catch (e) { throw new RangeError('gave up'); }",
    "try { work(); } catch (e) { throw new AggregateError([], 'gave up'); }",
    "try { work(); } catch (e) { throw Error('gave up'); }",
    'try { work(); } catch (err) { throw new Error(config.err); }',
  ];
  for (const source of sources) assert.deepEqual(errorRules(source), ['error-rethrown-without-cause'], source);
});

test('error-rethrown-without-cause accepts a cause, a use of the caught error and client-facing errors', () => {
  const sources = [
    "try { work(); } catch (err) { throw new Error('work failed', { cause: err }); }",
    "try { work(); } catch (err) { throw new Error('work failed', { cause: previous }); }",
    'try { work(); } catch (err) { throw new Error(`work failed: ${err}`); }',
    "try { work(); } catch (err) { logger.error(err); throw new Error('work failed'); }",
    "try { work(); } catch (err) { if (err.code === 'ENOENT') throw new Error('missing'); throw err; }",
    "try { work(); } catch { throw new Error('work failed'); }",
    "try { work(); } catch (err) { throw new NotFoundException('no such user'); }",
    "try { work(); } catch (err) { throw new AppError('NOT_FOUND', { message: 'no such user' }); }",
    "try { work(); } catch (e) { if (retry) { throw new Error('gave up'); } }",
    "try { work(); } catch (_error) { throw new Error('work failed'); }",
    "try { work(); } catch (e) { cleanup(); throw new Error('gave up'); }",
    "try { work(); } catch (err) { callbacks.push(() => { throw new Error('later'); }); }",
    "try { work(); } catch (err) { throw wrap('work failed'); }",
  ];
  for (const source of sources) assert.deepEqual(errorRules(source), [], source);
});

test('throw-non-error reports strings, numbers, templates and object literals', () => {
  const sources = [
    "throw 'not found';",
    'throw `missing ${name}`;',
    'throw 404;',
    "throw { status: 404, message: 'gone' };",
    "throw 'failed: ' + reason;",
    'throw [1, 2];',
    'throw null;',
    'throw -1;',
    'throw -1n;',
    'throw undefined;',
  ];
  for (const source of sources) assert.deepEqual(errorRules(source), ['throw-non-error'], source);
});

test('throw-non-error accepts errors, variables and calls', () => {
  const sources = [
    "throw new Error('failed');",
    'throw error;',
    'throw redirect("/login");',
    'throw createError({ status: 404 });',
    'throw this.failure;',
    "throw Object.assign(new Error('x'), { status: 404 });",
  ];
  for (const source of sources) assert.deepEqual(errorRules(source), [], source);
});

test('error-logged-without-stack reports a catch that logs only the message and carries on', () => {
  const sources = [
    'try { work(); } catch (err) { console.error(err.message); }',
    "try { work(); } catch (err) { logger.error('failed: ' + err.message); }",
    'try { work(); } catch (err) { this.logger.error(`failed: ${err.message}`); return null; }',
    "try { work(); } catch (err) { console.error('failed', err.message); res.status(500).end(); }",
    'try { work(); } catch (err) { if (err instanceof Error) console.error(err.message); }',
    'try { work(); } catch (err) { console.error(err.message); try { cleanup(); } catch (err) { console.error(err); } }',
    'try { work(); } catch (err) { console.error(err.message); try { cleanup(); } catch (err) { console.error(err); } }',
  ];
  for (const source of sources) assert.deepEqual(errorRules(source), ['error-logged-without-stack'], source);
});

test('error-logged-without-stack accepts logs with the error, a rethrow, an exit or other uses', () => {
  const sources = [
    'try { work(); } catch (err) { console.error(err); }',
    'try { work(); } catch (err) { console.error(err.message, err.stack); }',
    "try { work(); } catch (err) { logger.error({ err }, 'failed'); }",
    'try { work(); } catch (err) { console.error(err.message); throw err; }',
    'try { work(); } catch (err) { console.error(err.message); process.exit(1); }',
    'try { work(); } catch (err) { console.log(err.message); }',
    "try { work(); } catch (err) { logger.warn('failed: ' + err.message); }",
    'try { work(); } catch (err) { console.error(err.message); report(err); }',
    'try { work(); } catch (err) { console.error(err.code, err.message); }',
    "try { work(); } catch (err) { console.error('failed'); }",
  ];
  for (const source of sources) assert.deepEqual(errorRules(source), [], source);
});

test('throw-non-error is not skipped for production folders that merely contain "test" in their name', () => {
  for (const file of ['src/latest/service.ts', 'src/contest/service.ts']) {
    const found = withProgram("throw 'x';", noPackages, (_program, sourceFile) => checkErrorValues(sourceFile, file));
    assert.deepEqual(
      found.map(({ ruleId }) => ruleId),
      ['throw-non-error'],
      file,
    );
  }
});

test('throw-non-error and error-logged-without-stack skip fixtures, e2e helpers, test utilities and migrations', () => {
  const source = "throw 'x'; try { work(); } catch (err) { console.error(err.message); }";
  for (const file of ['src/__fixtures__/route.ts', 'e2e/utils.ts', 'libs/testing/server.ts', 'db/migrations/1.ts']) {
    const found = withProgram(source, noPackages, (_program, sourceFile) => checkErrorValues(sourceFile, file));
    assert.deepEqual(found, [], file);
  }
});
