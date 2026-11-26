// Fails when README.md, `loadwise --help` or package.json `files` drift apart.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { impactByRule } from '../../lib/performance/rule-ids.js';
import { impactByRule as impactByRuleRuleIds } from '../../lib/maintainability/rule-ids.js';
import { securityRules } from '../../lib/security/rule-ids.js';

const root = path.join(import.meta.dirname, '..', '..');
const binEntry = path.join(root, 'bin', 'loadwise.js');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replaceAll('\r\n', '\n');
const packageJson: { files: string[] } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const helpText = spawnSync(process.execPath, [binEntry, '--help'], { encoding: 'utf8' }).stdout;

test('every loadwise --help flag and command is in the README', () => {
  const flags = new Set(helpText.match(/--[a-z][a-z-]*/g));
  const commands = new Set([...helpText.matchAll(/^ {2}(loadwise(?: [a-z]+)+)/gm)].map((match) => match[1]));
  assert.ok(flags.size >= 8 && commands.size >= 4, 'could not parse --help');
  const missing = [...flags, ...commands].filter((name) => !readme.includes(name));
  assert.deepEqual(missing, [], `README does not mention: ${missing.join(', ')}`);
});

test('the README names no retired command or package', () => {
  const retired = readme.match(/warden-backend|warden-maint|@codewarden|codewarden/gi) ?? [];
  assert.deepEqual(retired, []);
});

function runtimeRequires(entryFile: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entryFile)) return seen;
  seen.add(entryFile);
  const source = fs.readFileSync(entryFile, 'utf8');
  const relativeLiterals = [...source.matchAll(/['"](\.{1,2}\/[\w./-]+)['"]/g)].map((match) => match[1]);
  for (const literal of relativeLiterals) {
    const target = [literal, `${literal}.js`, `${literal}/index.js`, `${literal}.cjs`, `${literal}/index.cjs`]
      .map((candidate) => path.resolve(path.dirname(entryFile), candidate))
      .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (target?.endsWith('.js') || target?.endsWith('.cjs')) runtimeRequires(target, seen);
    else if (target) seen.add(target);
  }
  return seen;
}

test('package.json files covers every runtime require reachable from bin/', () => {
  const entries = fs
    .readdirSync(path.join(root, 'bin'))
    .filter((name) => name.endsWith('.js') || name.endsWith('.cjs'))
    .map((name) => path.join(root, 'bin', name));
  const reachable = entries.flatMap((entry) => [...runtimeRequires(entry)]);
  assert.ok(
    reachable.some((file) => file.includes(path.join('lib', 'maintainability'))),
    'bin reaches both checkers',
  );
  const patterns = packageJson.files.map((entry) => entry.replace(/\/$/, ''));
  const uncovered = reachable
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .filter(
      (file) =>
        file !== 'package.json' && !patterns.some((pattern) => file === pattern || file.startsWith(`${pattern}/`)),
    );
  assert.deepEqual(uncovered, [], `not shipped by package.json files: ${uncovered.join(', ')}`);
});

// SARIF helpUri points at README#<rule-id>. syntax-error skips the unparsable file instead of
// becoming a finding, so it has none.
test('every rule id has exactly one README anchor', () => {
  const ruleIds = [...Object.keys(impactByRule), ...Object.keys(impactByRuleRuleIds), ...securityRules].filter(
    (ruleId) => ruleId !== 'syntax-error',
  );
  const anchorCount = (ruleId: string) => readme.split(`<a id="${ruleId}"></a>`).length - 1;
  assert.deepEqual(
    ruleIds.filter((ruleId) => anchorCount(ruleId) !== 1),
    [],
  );
});

test('npm pack ships examples/*.ts and no implementation .ts or .cts source files', () => {
  const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  assert.equal(pack.status, 0, pack.stderr || 'npm pack --dry-run --json failed');
  const parsed: { files?: { path: string }[] }[] = JSON.parse(pack.stdout);
  const packedPaths = (parsed[0]?.files ?? []).map((entry) => entry.path);
  assert.ok(packedPaths.length > 0, 'npm pack reported no files');
  assert.ok(packedPaths.includes('examples/slow.ts'), 'npm pack should include examples/slow.ts');
  assert.ok(packedPaths.includes('examples/indexed.ts'), 'npm pack should include examples/indexed.ts');
  const ctsSources = packedPaths.filter((filePath) => filePath.endsWith('.cts'));
  assert.deepEqual(ctsSources, [], `npm pack should not include .cts sources: ${ctsSources.join(', ')}`);
  const implTsSources = packedPaths.filter(
    (filePath) => filePath.endsWith('.ts') && !filePath.endsWith('.d.ts') && !filePath.startsWith('examples/'),
  );
  assert.deepEqual(implTsSources, [], `npm pack should not include .ts sources: ${implTsSources.join(', ')}`);
});
