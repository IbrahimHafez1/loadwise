import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { analyzeSources, reliabilityAnalyzer } from '../../lib/performance/projects.js';
import { checkSwallowedErrors } from '../../lib/reliability/swallowed-errors.js';

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

const emptyCatch = 'function run() {\n  try {\n    work();\n  } catch {}\n}\n';

// Each entry is a file path inside the project; configs lists the tsconfig folders, each including `src`.
function reportedFiles(files: string[], configFolders: string[] = ['.']): string[] {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-standalone-'));
  try {
    fs.mkdirSync(path.join(directory, '.git'));
    for (const folder of configFolders) {
      fs.mkdirSync(path.join(directory, folder, 'src'), { recursive: true });
      fs.writeFileSync(path.join(directory, folder, 'tsconfig.json'), '{"compilerOptions":{},"include":["src"]}');
    }
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      fs.writeFileSync(path.join(directory, file), emptyCatch);
    }
    const { findings } = analyzeSources({
      project: configFolders.map((folder) => path.join(directory, folder, 'tsconfig.json')),
      files: [],
      analyzers: [reliabilityAnalyzer],
    });
    return findings
      .filter((finding) => finding.ruleId === 'swallowed-error')
      .map((finding) => path.relative(directory, path.resolve(finding.file ?? '')).replaceAll('\\', '/'))
      .sort();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('a JavaScript file outside the tsconfig include is checked once beside the program files', () => {
  assert.deepEqual(reportedFiles(['src/main.ts', 'scripts/build.js']), ['scripts/build.js', 'src/main.ts']);
});

test('a script outside two tsconfig programs is reported exactly once', () => {
  assert.deepEqual(reportedFiles(['a/src/one.ts', 'b/src/two.ts', 'tools/release.js'], ['a', 'b']), [
    'a/src/one.ts',
    'b/src/two.ts',
    'tools/release.js',
  ]);
});

test('standalone files with a finding at the same line and column are all reported', () => {
  assert.deepEqual(reportedFiles(['src/main.ts', 'scripts/one.js', 'scripts/two.js']), [
    'scripts/one.js',
    'scripts/two.js',
    'src/main.ts',
  ]);
});
