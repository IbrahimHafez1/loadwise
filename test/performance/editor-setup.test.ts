import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import ts from 'typescript';
import { setupEditor } from '../../lib/performance/editor-setup.js';
import type { ProblemMatcherPattern, TasksFile } from '../types/editor-tasks.js';

function parseTasks(text: string): TasksFile {
  return JSON.parse(text);
}

function workspace(context: TestContext, contents?: string) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'checker-editor-setup-'));
  const folder = path.join(root, '.vscode');
  const filename = path.join(folder, 'tasks.json');
  if (contents !== undefined) {
    fs.mkdirSync(folder);
    fs.writeFileSync(filename, contents);
  }
  context.after(() => {
    if (fs.existsSync(filename)) fs.unlinkSync(filename);
    if (fs.existsSync(folder)) fs.rmdirSync(folder);
    fs.rmdirSync(root);
  });
  return { root, filename };
}

test('setup creates one background process task whose matcher captures paths, severity, rule and full example', (context) => {
  const { root, filename } = workspace(context);
  assert.deepEqual(setupEditor(root), { filename, changed: true });
  const original = fs.readFileSync(filename, 'utf8');
  const task = parseTasks(original).tasks[0];
  assert.equal(task.type, 'process');
  assert.equal(task.command, 'node');
  assert.deepEqual(task.args, ['${workspaceFolder}/node_modules/loadwise/bin/loadwise.js', 'perf', 'editor', 'watch']);
  assert.equal(task.runOptions.runOn, 'folderOpen');
  assert.equal(task.runOptions.instanceLimit, 1);
  assert.equal(task.isBackground, true);
  const matcher = task.problemMatcher;
  const pattern = matcher.pattern;
  const fields = [
    'src/a | b.ts',
    '12',
    '2',
    '9',
    'warning',
    'deep-control-flow',
    'Use a guard. Example: if (!ok) return; | or skip',
  ];
  const marker = new RegExp(pattern.regexp).exec(['LOADWISE', ...fields].join(' | '));
  assert.ok(marker);
  const markerFields: Exclude<keyof ProblemMatcherPattern, 'regexp'>[] = [
    'file',
    'line',
    'column',
    'endColumn',
    'severity',
    'code',
    'message',
  ];
  assert.deepEqual(
    markerFields.map((key) => marker[pattern[key]]),
    fields,
  );
  assert.deepEqual(matcher.fileLocation, ['relative', '${workspaceFolder}']);
  assert.ok(new RegExp(matcher.background.beginsPattern).test('Loadwise: scan started'));
  assert.ok(new RegExp(matcher.background.endsPattern).test('Loadwise: scan finished'));
  assert.deepEqual(setupEditor(root), { filename, changed: false });
  assert.equal(fs.readFileSync(filename, 'utf8'), original);
});

test('setup edits JSONC without dropping existing comments, BOM, CRLF, task order or settings', (context) => {
  const contents =
    '\uFEFF{\r\n  // existing inputs\r\n  "inputs": [],\r\n  "tasks": [\r\n    // keep with build\r\n    { "label": "build", "command": "echo \\"text\\"" },\r\n  ],\r\n}\r\n';
  const { root, filename } = workspace(context, contents);
  setupEditor(root);
  const text = fs.readFileSync(filename, 'utf8');
  assert.ok(text.startsWith('\uFEFF{'));
  assert.ok(text.includes('// keep with build\r\n    { "label": "build", "command": "echo \\"text\\"" },'));
  assert.ok(text.includes('// existing inputs\r\n  "inputs": [],'));
  assert.doesNotMatch(text, /(?<!\r)\n/);
  const result = ts.parseConfigFileTextToJson(filename, text);
  assert.equal(result.error, undefined);
  assert.equal(result.config.version, '2.0.0');
  assert.equal(result.config.tasks.length, 2);
  assert.deepEqual(result.config.inputs, []);
  assert.equal(setupEditor(root).changed, false);
});

test('setup adds missing tasks to existing task files and reports a conflicting label without altering the file', (context) => {
  const seed = '{ /* retained */ "version": "2.0.0", "inputs": [], }';
  const { root, filename } = workspace(context, seed);
  setupEditor(root);
  const text = fs.readFileSync(filename, 'utf8');
  const result = ts.parseConfigFileTextToJson(filename, text);
  assert.equal(result.error, undefined);
  assert.ok(text.includes('/* retained */'));
  result.config.tasks[0].command = 'owner-command';
  const owned = JSON.stringify(result.config);
  fs.writeFileSync(filename, owned);
  assert.throws(() => setupEditor(root), /different or duplicate/);
  assert.equal(fs.readFileSync(filename, 'utf8'), owned);
});

test('invalid JSONC, unsupported versions, duplicates and malformed task lists fail before writing', (context) => {
  const { root, filename } = workspace(context, '{}');
  for (const original of ['{', '[]', '{"version":"0.1.0"}', '{"tasks":null}', '{"tasks":[], "tasks":[]}']) {
    fs.writeFileSync(filename, original);
    assert.throws(() => setupEditor(root));
    assert.equal(fs.readFileSync(filename, 'utf8'), original);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(filename)), ['tasks.json']);
});

test(
  'bounded Windows sharing retries preserve concurrent editor task changes',
  { skip: process.platform !== 'win32' },
  (context) => {
    const { root, filename } = workspace(context, '{}');
    const rename = fs.renameSync;
    const sharingError = Object.assign(new Error('sharing violation'), { code: 'EPERM' });
    let attempts = 0;
    let editDuringRetry = false;
    let persistentlyLocked = false;
    context.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (to === filename && (attempts++ === 0 || persistentlyLocked)) {
        if (editDuringRetry) fs.writeFileSync(filename, '{"owner": "concurrent change"}');
        throw sharingError;
      }
      return rename(from, to);
    });
    assert.equal(setupEditor(root).changed, true);
    assert.equal(attempts, 2);
    attempts = 0;
    editDuringRetry = true;
    fs.writeFileSync(filename, '{}');
    assert.throws(() => setupEditor(root), /changed during setup/);
    assert.equal(attempts, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), { owner: 'concurrent change' });
    attempts = 0;
    editDuringRetry = false;
    persistentlyLocked = true;
    assert.throws(
      () => setupEditor(root),
      (error) => error === sharingError,
    );
    assert.equal(attempts, 4);
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), { owner: 'concurrent change' });
  },
);
