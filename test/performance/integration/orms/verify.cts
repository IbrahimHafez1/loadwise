import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const packageRoot = path.resolve(__dirname, '../../../..');
const checker = path.join(packageRoot, 'bin', 'loadwise.js');
const compiler = require.resolve('typescript/bin/tsc', { paths: [packageRoot] });
const ruleNames = { loop: 'orm-query-in-loop', count: 'orm-count-materialization', lean: 'mongoose-missing-lean' };
const markerPrefix = '// expect ';

function run(script, args, expectedExit) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: __dirname, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, expectedExit, result.stderr || result.stdout);
  return result.stdout;
}

const source = fs.readFileSync(path.join(__dirname, 'app.ts'), 'utf8');
const expected = [];
for (const [index, line] of source.split(/\r?\n/).entries()) {
  // `// expect <kind> <token>`; several findings on one line are separated by `;`, in the order the checker reports them.
  const markerStart = line.indexOf(markerPrefix);
  if (markerStart < 0) continue;
  const code = line.slice(0, markerStart);
  for (const marker of line.slice(markerStart + markerPrefix.length).split(';')) {
    const [kind, token] = marker.trim().split(' ');
    assert.ok(kind in ruleNames, `Unknown marker kind "${kind}" on line ${index + 1}`);
    const column = code.lastIndexOf(token) + 1;
    assert.ok(column > 0, `Missing marked token on line ${index + 1}`);
    expected.push({ file: 'app.ts', line: index + 1, column, ruleId: ruleNames[kind] });
  }
}
assert.ok(expected.length > 0);
run(compiler, ['-p', 'tsconfig.json'], 0);

function verify(flags) {
  const result = JSON.parse(run(checker, ['perf', '-p', 'tsconfig.json', '--json', ...flags], 1));
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
