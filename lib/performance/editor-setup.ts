import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import type { Expression, JsonSourceFile, ObjectLiteralExpression } from 'typescript';

/** One entry of a parsed tasks.json `tasks` array. */
interface ConfiguredTask {
  label?: unknown;
}

/** The parsed tasks.json; `tasks` is read only after the syntax tree shows it is an array. */
interface ConfiguredTasks {
  version?: unknown;
  tasks: readonly (ConfiguredTask | null)[];
}

interface ExistingFile {
  text: string;
  mode: number;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

const watchTask = {
  label: 'Loadwise: Watch',
  type: 'process',
  command: 'node',
  args: ['${workspaceFolder}/node_modules/loadwise/bin/loadwise.js', 'perf', 'editor', 'watch'],
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
        '^LOADWISE \\| (.+?) \\| (\\d+) \\| (\\d+) \\| (\\d+) \\| (error|warning) \\| ([a-z0-9-]+) \\| ([\\s\\S]+)$',
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

// Insert immediately after the opening bracket. Everything the user wrote, including comments,
// stays in place.
function prependItems(text: string, opening: number, items: string, hasExisting: boolean): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lineStart = text.lastIndexOf('\n', opening) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart, opening))?.[0] ?? '';
  const childIndent = indent + (indent.includes('\t') ? '\t' : '  ');
  const insertion = items
    .split('\n')
    .map((line) => childIndent + line)
    .join(newline);
  const tail = text.slice(opening + 1);
  const separator = /^[ \t]*\r?\n/.test(tail) ? '' : newline + (hasExisting ? childIndent : indent);
  return text.slice(0, opening + 1) + newline + insertion + (hasExisting ? ',' : '') + separator + tail;
}

interface ParsedTasksFile {
  source: JsonSourceFile;
  config: ConfiguredTasks;
  object: ObjectLiteralExpression;
}

function parseTasksFile(filename: string, text: string): ParsedTasksFile {
  const source = ts.parseJsonText(filename, text);
  const errors = [...(source.parseDiagnostics ?? [])];
  const config: ConfiguredTasks = ts.convertToObject(source, errors);
  const object = source.statements[0]?.expression;
  if (errors.length || !object || !ts.isObjectLiteralExpression(object)) {
    throw new Error(filename + ' must contain a valid JSONC object. Correct the existing file and retry.');
  }
  if (Object.hasOwn(config, 'version') && config.version !== '2.0.0') {
    throw new Error(filename + ' uses an incompatible task version. Migrate it to 2.0.0 first.');
  }
  return { source, config, object };
}

function topLevelSettings(filename: string, object: ObjectLiteralExpression): Map<string, Expression> {
  const settings = new Map<string, Expression>();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)))
      continue;
    const name = property.name.text;
    if (name !== 'tasks' && name !== 'version') continue;
    if (settings.has(name)) throw new Error(filename + ' contains duplicate ' + name + ' properties.');
    settings.set(name, property.initializer);
  }
  return settings;
}

function existingWatchTasks(filename: string, config: ConfiguredTasks): (ConfiguredTask | null)[] {
  const matches = config.tasks.filter((task) => task?.label === watchTask.label);
  if (matches.length > 1 || (matches.length && !isDeepStrictEqual(matches[0], watchTask))) {
    throw new Error(
      filename +
        ' already defines a different or duplicate "' +
        watchTask.label +
        '". Rename or reconcile it before setup.',
    );
  }
  return matches;
}

function updatedTasks(filename: string, text: string | undefined): string {
  if (text === undefined) return JSON.stringify({ version: '2.0.0', tasks: [watchTask] }, null, 2) + '\n';
  const { source, config, object } = parseTasksFile(filename, text);
  const settings = topLevelSettings(filename, object);
  const members: string[] = [];
  if (!settings.has('version')) members.push('"version": "2.0.0"');
  const tasks = settings.get('tasks');
  if (!tasks) {
    members.push('"tasks": ' + JSON.stringify([watchTask], null, 2));
  } else {
    if (!ts.isArrayLiteralExpression(tasks)) throw new Error(filename + ' must have an array for tasks.');
    const matches = existingWatchTasks(filename, config);
    if (!matches.length)
      text = prependItems(text, tasks.getStart(source), JSON.stringify(watchTask, null, 2), tasks.elements.length > 0);
  }
  return members.length
    ? prependItems(text, object.getStart(source), members.join(',\n'), object.properties.length > 0)
    : text;
}

function readExisting(filename: string): ExistingFile | undefined {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile()) throw new Error(filename + ' must be a regular file.');
  return { text: fs.readFileSync(filename, 'utf8'), mode: stat.mode };
}

// Windows editors and indexers can briefly open tasks.json without sharing delete access.
const sharingErrors = new Set(['EPERM', 'EBUSY', 'EACCES']);
const renameBackoffMs = [25, 50, 100];
function replaceExisting(temporary: string, filename: string, existing: ExistingFile): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temporary, filename);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (
        process.platform !== 'win32' ||
        code === undefined ||
        !sharingErrors.has(code) ||
        attempt >= renameBackoffMs.length
      )
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, renameBackoffMs[attempt]);
      const current = readExisting(filename);
      if (existing.text !== current?.text || existing.mode !== current?.mode)
        throw new Error(filename + ' changed during setup. Run setup again.');
    }
  }
}

function setupEditor(root: string): { filename: string; changed: boolean } {
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory())
    throw new Error('Expected an existing workspace directory.');
  const folder = path.resolve(root, '.vscode');
  fs.mkdirSync(folder, { recursive: true });
  if (!fs.lstatSync(folder).isDirectory()) throw new Error(folder + ' must be a regular workspace directory.');
  const filename = path.join(folder, 'tasks.json');
  const existing = readExisting(filename);
  const text = updatedTasks(filename, existing?.text);
  if (text === existing?.text) return { filename, changed: false };

  const temporary = path.join(folder, '.loadwise-' + randomUUID() + '.tmp');
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
        const code = errorCode(error);
        if (code === 'EEXIST' && readExisting(filename)?.text === text) return { filename, changed: false };
        if (code === undefined || !['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(code)) throw error;
        fs.copyFileSync(temporary, filename, fs.constants.COPYFILE_EXCL);
      }
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { filename, changed: true };
}

export { setupEditor };
