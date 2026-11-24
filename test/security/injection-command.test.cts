// command-injection: request data in a command line a shell parses. Fixed commands, array arguments
// without a shell, environment values and untraced wrapper parameters (contextual) are covered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintBothWays, lintWithoutTypes, stubs } from './helpers.cjs';
import type { Finding } from '../../lib/shared/types.cjs';

const ruleId = 'command-injection';
const packages = {
  ...stubs.express,
  'node_modules/@types/node/index.d.ts': [
    "declare module 'child_process' {",
    '  export function exec(command: string, callback?: unknown): void;',
    '  export function execSync(command: string): string;',
    '  export function execFile(file: string, args: string[], options?: object): void;',
    '  export function spawn(command: string, args?: string[], options?: object): void;',
    '}',
    "declare module 'node:child_process' { export * from 'child_process'; }",
    "declare module 'util' { export function promisify<T>(fn: T): (...args: unknown[]) => Promise<unknown>; }",
    'declare const process: { env: Record<string, string | undefined> };',
  ].join('\n'),
  'node_modules/execa/index.d.ts': [
    'export declare function execa(file: string, args?: string[], options?: object): Promise<unknown>;',
    'export declare function execaCommand(command: string): Promise<unknown>;',
  ].join('\n'),
};

function route(...body: string[]) {
  return [
    "import express from 'express';",
    "import { exec, execSync, execFile, spawn } from 'node:child_process';",
    "import * as cp from 'child_process';",
    "import { promisify } from 'util';",
    "import { execa, execaCommand } from 'execa';",
    'const execAsync = promisify(exec);',
    'const app = express();',
    "app.post('/x', (req, res) => {",
    ...body,
    '});',
  ].join('\n');
}

function commandFindings(source: string) {
  const { typed } = lintBothWays(source, packages);
  return typed
    .filter((finding: Finding) => finding.ruleId === ruleId)
    .map((finding: Finding) => [finding.line, finding.contextualReason ? 'C' : 'D']);
}

test('request data in exec, a promisified exec, a shell spawn and execa commands is reported', () => {
  const source = route(
    'exec(`convert ${req.body.file} out.png`);',
    "const name = req.query.name;\ncp.execSync('git log ' + name);",
    'execAsync(`ping ${req.query.host}`);',
    "spawn('sh', ['-c', `tar xf ${req.body.archive}`]);",
    "execFile('grep', [req.body.pattern], { shell: true });",
    'execaCommand(`ls ${req.query.dir}`);',
    "execa('ls', [req.query.dir], { shell: true });",
  );
  assert.deepEqual(commandFindings(source), [
    [9, 'D'],
    [11, 'D'],
    [12, 'D'],
    [13, 'D'],
    [14, 'D'],
    [15, 'D'],
    [16, 'D'],
  ]);
  assert.equal(
    lintWithoutTypes(source, packages)[0].message,
    '`req.body.file` reaches a shell command line, so shell metacharacters in it run as commands. Call `execFile`/`spawn` without `shell` and pass the value as an array element.',
  );
});

test('fixed commands, argument arrays without a shell and environment values are silent', () => {
  const source = route(
    "exec('git status');",
    "execFile('convert', [req.body.file, 'out.png']);",
    "spawn('git', ['log', req.query.ref]);",
    "spawn('sh', ['-c', 'echo done']);",
    'execSync(`deploy ${process.env.TARGET}`);',
    "execa('ls', [req.query.dir]);",
    "execFile('grep', [req.body.pattern], { shell: false });",
  );
  assert.deepEqual(commandFindings(source), []);
});

test('an interpolated wrapper parameter with no traced caller is contextual; a bare one is silent', () => {
  const source = [
    "import { exec } from 'child_process';",
    'export function run(directory: string, command: string) {',
    '  exec(`cd ${directory} && make`);',
    '  exec(command);',
    '}',
  ].join('\n');
  const findings = lintBothWays(source, packages).typed.filter((finding: Finding) => finding.ruleId === ruleId);
  assert.deepEqual(
    findings.map((finding: Finding) => [finding.line, finding.contextualReason]),
    [[3, 'The interpolated value is a parameter with no traced caller; confirm no caller passes request data.']],
  );
});

test('a request value reaching a helper is default', () => {
  const source = [
    "import express from 'express';",
    "import { exec } from 'child_process';",
    'function thumbnail(file: string) { exec(`convert ${file} thumb.png`); }',
    'const app = express();',
    "app.post('/x', (req, res) => thumbnail(req.body.file));",
  ].join('\n');
  assert.deepEqual(commandFindings(source), [[3, 'D']]);
});

test('an exec function that is not from child_process is not a sink', () => {
  const source = route('const db = { exec(text: string) {} };', 'db.exec(`VACUUM ${req.query.table}`);');
  assert.deepEqual(commandFindings(source), []);
});
