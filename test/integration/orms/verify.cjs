'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '../../..');
const checker = path.join(packageRoot, 'bin', 'warden-backend.cjs');
const compiler = require.resolve('typescript/bin/tsc', { paths: [packageRoot] });
const ruleNames = { loop: 'orm-query-in-loop', count: 'orm-count-materialization' };

function run(script, args, expectedExit) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: __dirname, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, expectedExit, result.stderr || result.stdout);
  return result.stdout;
}

const source = fs.readFileSync(path.join(__dirname, 'app.ts'), 'utf8');
const expected = [];
for (const [index, line] of source.split(/\r?\n/).entries()) {
  const marker = /\/\/ expect (loop|count) (\w+)$/.exec(line);
  if (!marker) continue;
  const column = line.slice(0, marker.index).lastIndexOf(marker[2]) + 1;
  assert.ok(column > 0, `Missing marked token on line ${index + 1}`);
  expected.push({ file: 'app.ts', line: index + 1, column, ruleId: ruleNames[marker[1]] });
}
assert.ok(expected.length > 0);
run(compiler, ['-p', 'tsconfig.json'], 0);

function verify(flags) {
  const result = JSON.parse(run(checker, ['-p', 'tsconfig.json', '--json', ...flags], 1));
  assert.equal(result.scannedFiles, 1);
  // Comparing the complete set catches reports on clean controls as well as missed detections.
  assert.deepEqual(
    result.findings.map(({ file, line, column, ruleId }) => ({ file, line, column, ruleId })),
    expected,
  );
  console.log(`${flags.length ? 'Native' : 'Default'} checker matched all ${expected.length} locations.`);
  return result;
}

const args = process.argv.slice(2);
if (args.length && !(args.length === 1 && args[0] === '--native'))
  throw new Error('Usage: npm run verify -- [--native]');
const classic = verify([]);
if (args.length) assert.deepEqual(verify(['--native']), classic);
