'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const ts = require('typescript');

const watchTask = {
  label: 'Loadwise: Watch',
  type: 'process',
  command: 'node',
  args: ['${workspaceFolder}/node_modules/@loadwise/cli/bin/loadwise.cjs', 'perf', 'editor', 'watch'],
  options: { cwd: '${workspaceFolder}' },
  isBackground: true,
  runOptions: { runOn: 'folderOpen', instanceLimit: 1 },
  presentation: { reveal: 'silent', revealProblems: 'never', panel: 'dedicated', clear: false },
  problemMatcher: {
    owner: 'loadwise',
    source: 'Loadwise',
    applyTo: 'allDocuments',
    fileLocation: ['relative', '${workspaceFolder}'],
    pattern: {
      regexp:
        '^BACKEND_CHECKER \\| (.+?) \\| (\\d+) \\| (\\d+) \\| (\\d+) \\| (error|warning) \\| ([a-z0-9-]+) \\| ([\\s\\S]+)$',
      file: 1,
      line: 2,
      column: 3,
      endColumn: 4,
      severity: 5,
      code: 6,
      message: 7,
    },
    background: {
      activeOnStart: false,
      beginsPattern: '^Loadwise: scan started$',
      endsPattern: '^Loadwise: scan finished$',
    },
  },
};

const legacyLabel = 'Backend Checkers: Watch';
const legacyBin = '${workspaceFolder}/node_modules/backend-perf-check/bin/backend-perf-check.cjs';
const legacyTask = {
  ...watchTask,
  label: legacyLabel,
  args: [legacyBin, 'editor', 'watch'],
  problemMatcher: {
    ...watchTask.problemMatcher,
    owner: 'backend-checkers',
    source: 'Backend Checkers',
    background: {
      activeOnStart: false,
      beginsPattern: '^Backend Checkers: scan started$',
      endsPattern: '^Backend Checkers: scan finished$',
    },
  },
};

// Edit only tokens belonging to a generated task so inline JSONC comments survive the upgrade.
function migrateLegacyTask(source, array, index, hasCurrent) {
  const node = array.elements[index];
  const start = node.getStart(source);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source.text);
  scanner.setTextPos(start);
  const replacements = new Map([
    [legacyLabel, watchTask.label],
    [legacyBin, watchTask.args[0]],
    [legacyTask.problemMatcher.owner, watchTask.problemMatcher.owner],
    [legacyTask.problemMatcher.source, watchTask.problemMatcher.source],
    [legacyTask.problemMatcher.background.beginsPattern, watchTask.problemMatcher.background.beginsPattern],
    [legacyTask.problemMatcher.background.endsPattern, watchTask.problemMatcher.background.endsPattern],
  ]);
  let previous = start;
  let replacement = '';
  while (previous < node.end) {
    const kind = scanner.scan();
    replacement += source.text.slice(previous, scanner.getTokenPos());
    if (!hasCurrent) {
      const value = kind === ts.SyntaxKind.StringLiteral && scanner.getTokenValue();
      if (value === 'editor') replacement += '"perf", ';
      replacement += replacements.has(value) ? JSON.stringify(replacements.get(value)) : scanner.getTokenText();
    }
    previous = scanner.getTextPos();
  }
  const before = source.text.slice(0, start);
  const after = source.text.slice(node.end);
  if (!hasCurrent) return before + replacement + after;
  // Retain comments from a redundant generated task; omit empty whitespace otherwise.
  const comments = replacement.trim() ? replacement : '';
  if (scanner.scan() === ts.SyntaxKind.CommaToken)
    return (
      before + comments + source.text.slice(node.end, scanner.getTokenPos()) + source.text.slice(scanner.getTextPos())
    );
  // Last task in a strict JSON array: remove its preceding comma, retaining adjacent comments.
  scanner.setTextPos(array.elements[index - 1].end);
  scanner.scan();
  return (
    source.text.slice(0, scanner.getTokenPos()) + source.text.slice(scanner.getTextPos(), start) + comments + after
  );
}

// Insert immediately after the opening bracket. Everything the user wrote, including comments, stays in place.
function prependItems(text, opening, items, hasExisting) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lineStart = text.lastIndexOf('\n', opening) + 1;
  const indent = text.slice(lineStart, opening).match(/^[ \t]*/)[0];
  const childIndent = indent + (indent.includes('\t') ? '\t' : '  ');
  const insertion = items
    .split('\n')
    .map((line) => childIndent + line)
    .join(newline);
  const tail = text.slice(opening + 1);
  const separator = /^[ \t]*\r?\n/.test(tail) ? '' : newline + (hasExisting ? childIndent : indent);
  return text.slice(0, opening + 1) + newline + insertion + (hasExisting ? ',' : '') + separator + tail;
}

function updatedTasks(filename, text) {
  if (text === undefined) return JSON.stringify({ version: '2.0.0', tasks: [watchTask] }, null, 2) + '\n';
  const source = ts.parseJsonText(filename, text);
  const errors = [...source.parseDiagnostics];
  const config = ts.convertToObject(source, errors);
  const object = source.statements[0]?.expression;
  if (errors.length || !object || !ts.isObjectLiteralExpression(object)) {
    throw new Error(filename + ' must contain a valid JSONC object. Correct the existing file and retry.');
  }
  if (Object.hasOwn(config, 'version') && config.version !== '2.0.0') {
    throw new Error(filename + ' uses an incompatible task version. Migrate it to 2.0.0 first.');
  }
  const settings = new Map();
  for (const property of object.properties) {
    const name = property.name.text;
    if (name !== 'tasks' && name !== 'version') continue;
    if (settings.has(name)) throw new Error(filename + ' contains duplicate ' + name + ' properties.');
    settings.set(name, property.initializer);
  }
  const members = [];
  if (!settings.has('version')) members.push('"version": "2.0.0"');
  const tasks = settings.get('tasks');
  if (!tasks) {
    members.push('"tasks": ' + JSON.stringify([watchTask], null, 2));
  } else {
    if (!ts.isArrayLiteralExpression(tasks)) throw new Error(filename + ' must have an array for tasks.');
    const matches = config.tasks.filter((task) => task?.label === watchTask.label);
    if (matches.length > 1 || (matches.length && !isDeepStrictEqual(matches[0], watchTask))) {
      throw new Error(
        filename +
          ' already defines a different or duplicate "' +
          watchTask.label +
          '". Rename or reconcile it before setup.',
      );
    }
    const legacyIndex = config.tasks.findIndex(
      (task) => task?.label === legacyLabel && isDeepStrictEqual(task, legacyTask),
    );
    if (legacyIndex !== -1) {
      return updatedTasks(filename, migrateLegacyTask(source, tasks, legacyIndex, matches.length > 0));
    }
    if (!matches.length)
      text = prependItems(text, tasks.getStart(source), JSON.stringify(watchTask, null, 2), tasks.elements.length > 0);
  }
  return members.length
    ? prependItems(text, object.getStart(source), members.join(',\n'), object.properties.length > 0)
    : text;
}

function readExisting(filename) {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile()) throw new Error(filename + ' must be a regular file.');
  return { text: fs.readFileSync(filename, 'utf8'), mode: stat.mode };
}

// Windows editors and indexers can briefly open tasks.json without sharing delete access.
const sharingErrors = new Set(['EPERM', 'EBUSY', 'EACCES']);
const renameBackoffMs = [25, 50, 100];
function replaceExisting(temporary, filename, existing) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temporary, filename);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || !sharingErrors.has(error.code) || attempt >= renameBackoffMs.length)
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, renameBackoffMs[attempt]);
      const current = readExisting(filename);
      if (existing.text !== current?.text || existing.mode !== current.mode)
        throw new Error(filename + ' changed during setup. Run setup again.');
    }
  }
}

function setupEditor(root) {
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory())
    throw new Error('Expected an existing workspace directory.');
  const folder = path.resolve(root, '.vscode');
  fs.mkdirSync(folder, { recursive: true });
  if (!fs.lstatSync(folder).isDirectory()) throw new Error(folder + ' must be a regular workspace directory.');
  const filename = path.join(folder, 'tasks.json');
  const existing = readExisting(filename);
  const text = updatedTasks(filename, existing?.text);
  if (text === existing?.text) return { filename, changed: false };

  const temporary = path.join(folder, '.backend-checkers-' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: existing?.mode });
    const current = readExisting(filename);
    if (text === current?.text) return { filename, changed: false };
    if (existing?.text !== current?.text) throw new Error(filename + ' changed during setup. Run setup again.');
    if (existing) {
      fs.chmodSync(temporary, existing.mode);
      replaceExisting(temporary, filename, existing);
    } else {
      try {
        fs.linkSync(temporary, filename);
      } catch (error) {
        if (error.code === 'EEXIST' && readExisting(filename)?.text === text) return { filename, changed: false };
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error.code)) throw error;
        fs.copyFileSync(temporary, filename, fs.constants.COPYFILE_EXCL);
      }
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { filename, changed: true };
}

module.exports = { setupEditor };
