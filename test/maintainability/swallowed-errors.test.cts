import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { checkSwallowedErrors } from '../../lib/maintainability/swallowed-errors.cjs';

function check(source: string, file = 'src/example.ts') {
  return checkSwallowedErrors(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true), file);
}

test('an empty catch block is reported at the catch clause', () => {
  const findings = check('async function save() {\n  try {\n    await write();\n  } catch {}\n}');
  assert.deepEqual(
    findings.map(({ line, column, ruleId }) => [line, column, ruleId]),
    [[4, 5, 'swallowed-error']],
  );
  assert.match(findings[0].message, /empty/);
});

test('a catch that only logs is reported when the code carries on afterwards', () => {
  const sources = [
    'function run() { try { work(); } catch (error) { console.error(error); } done(); }',
    'function run() { try { work(); } catch (error) { this.logger.warn("failed", error); } done(); }',
    'function run(items) { for (const item of items) { try { work(item); } catch (error) { logger.error(error); } total += 1; } }',
  ];
  for (const source of sources) {
    const findings = check(source);
    assert.equal(findings.length, 1, source);
    assert.match(findings[0].message, /only logs/);
  }
});

test('a logging catch that ends its block, such as a per-item log in a loop, is not reported', () => {
  assert.deepEqual(check('function run() { try { work(); } catch (error) { console.error(error); } }'), []);
  assert.deepEqual(
    check(
      'function run(items) { for (const item of items) { try { work(item); } catch (error) { logger.error(error); } } }',
    ),
    [],
  );
});

test('a catch that explains itself with a comment is accepted', () => {
  assert.deepEqual(check('try { work(); } catch {\n  // The cache is optional.\n}\nnext();'), []);
  assert.deepEqual(check('try { work(); } catch { /* optional */ }\nnext();'), []);
  assert.deepEqual(check('try { work(); } catch (error) { console.warn(error); // best effort\n}\nnext();'), []);
});

test('a catch that rethrows, returns or records a failure is accepted', () => {
  const bodies = ['throw error;', 'return { error };', 'status = "failed";', 'console.error(error); throw error;'];
  for (const body of bodies) {
    assert.deepEqual(check(`function run() { try { work(); } catch (error) { ${body} } next(); }`), [], body);
  }
});

test('optional dependency probes and cleanup paths are accepted', () => {
  const sources = [
    'let native; try { native = require("optional-native"); } catch {}\nuse(native);',
    'async function load() { try { await import("optional"); } catch {} next(); }',
    'async function run() { try { await work(); } finally { try { await connection.close(); } catch {} } }',
    'async function run() { try { await work(); } catch (error) { try { await undo(); } catch {} throw error; } }',
    'async function run() { try { await socket.destroy(); } catch {} next(); }',
  ];
  for (const source of sources) assert.deepEqual(check(source), [], source);
});

test('test files are not checked', () => {
  assert.deepEqual(check('try { work(); } catch {}', 'src/example.spec.ts'), []);
});
