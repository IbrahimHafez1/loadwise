import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { buildFix, createFileCache } from '../../lib/maintainability/site-fix.cjs';
import type { TestContext } from 'node:test';
import type { Finding, FixChange } from '../../lib/shared/types.cjs';
import type { FileMap } from '../types/project-files.cjs';
import { checkSizeLimits } from '../../lib/maintainability/size-limits.cjs';
import { collectModuleUsage } from '../../lib/maintainability/module-usage.cjs';
import type * as Typescript from 'typescript';
const cli = path.join(__dirname, '../../bin/loadwise.cjs');

function project(context: TestContext, files: FileMap) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-improve-maint-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), content);
  }
  return directory;
}

function ruleFindings(directory: string, ruleId: string) {
  const result = spawnSync(process.execPath, [cli, 'maint', '--json', '--include-contextual'], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).findings.filter((finding: Finding) => finding.ruleId === ruleId);
}

// Points a finding at the first occurrence of `marker` in `file`, the way the scanner reports a
// declaration name.
function siteOf(directory: string, file: string, marker: string, occurrence = 0) {
  const lines = fs.readFileSync(path.join(directory, file), 'utf8').split('\n');
  const rows = lines.flatMap((row, index) => (row.includes(marker) ? [index] : []));
  const row = rows[occurrence];
  return { file, line: row + 1, column: lines[row].indexOf(marker) + 1 };
}

const utcComment = '  // Compare in UTC so a server time zone never shifts the day.';
const sharedBody = [
  '  const left = new Date(first);',
  '  const right = new Date(second);',
  '  return left.getUTCFullYear() === right.getUTCFullYear() && left.getUTCDate() === right.getUTCDate();',
];

function duplicateFix(context: TestContext, copyBody: readonly string[], keptBody: readonly string[] = sharedBody) {
  const source = [
    'export function sameDay(first, second) {',
    ...keptBody,
    '}',
    '',
    'export function sameDate(first, second) {',
    ...copyBody,
    '}',
    '',
  ].join('\n');
  const directory = project(context, { 'day.mjs': source });
  const finding: Finding = {
    ...siteOf(directory, 'day.mjs', 'sameDay'),
    ruleId: 'duplicate-implementation',
    message: 'duplicate',
    related: [siteOf(directory, 'day.mjs', 'sameDate')],
  };
  return buildFix(finding, createFileCache(directory));
}

test('duplicate-implementation withholds delegation when the replaced body has its own comments', (context) => {
  const commented = [sharedBody[0], utcComment, ...sharedBody.slice(1)];
  assert.equal(duplicateFix(context, commented), undefined);
  const trailing = [sharedBody[0] + ' // parsed in the server zone', ...sharedBody.slice(1)];
  assert.equal(duplicateFix(context, trailing), undefined);
});

test('duplicate-implementation still delegates when the kept implementation has the same comments', (context) => {
  const commented = [sharedBody[0], utcComment, ...sharedBody.slice(1)];
  const fix = duplicateFix(context, commented, commented);
  assert.ok(fix, 'expected the copy to delegate');
  assert.match(fix.changes[0].after, /return sameDay\(first, second\);/);
});

// The loop below is deep enough that the fix extracts it as `this.processMembers(...)`.
const tallyClass = (heading: readonly string[], signature = '  run(groups: Group[], out: Map<string, string>) {') =>
  [
    ...heading,
    signature,
    '    for (const group of groups) {',
    '      if (group.enabled) {',
    '        for (const member of group.members) {',
    '          if (member.id) {',
    "            out.set(member.id, 'seen');",
    '          }',
    "          out.set('member', member.id);",
    '        }',
    "        out.set('group', 'seen');",
    '      }',
    "      out.set('last', 'seen');",
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
const groupType = 'type Group = { enabled: boolean; members: { id: string }[] };';

test('extracted method is withheld when an imported base class may define its name', (context) => {
  const directory = project(context, {
    'base.ts': 'export class Base {\n  processMembers() {\n    return 1;\n  }\n}\n',
    'tally.ts': tallyClass(["import { Base } from './base';", groupType, 'export class Tally extends Base {']),
  });
  const [finding] = ruleFindings(directory, 'deep-control-flow');
  assert.ok(finding, 'expected the deep loop to be reported');
  assert.equal(finding.fix, undefined);
});

// A JavaScript file is not type-checked after the rewrite, so only the member check keeps the base
// method intact.
test('extracted method avoids a name a base class declares as a string member', (context) => {
  const base = ['class Base {', "  'processMembers'() {", '    return 1;', '  }', '}'];
  const tally = tallyClass([...base, 'export class Tally extends Base {'], '  run(groups, out) {');
  const directory = project(context, { 'tally.mjs': tally });
  const [finding] = ruleFindings(directory, 'deep-control-flow');
  assert.ok(finding, 'expected the deep loop to be reported');
  const added = (finding.fix?.changes ?? []).map((change: FixChange) => change.after).join('\n');
  assert.doesNotMatch(added, /processMembers/);
});

test('extracted method still applies under a base class whose members are known', (context) => {
  const base = ['class Base {', '  label = 1;', '}'];
  const directory = project(context, {
    'tally.ts': tallyClass([groupType, ...base, 'export class Tally extends Base {']),
  });
  const [finding] = ruleFindings(directory, 'deep-control-flow');
  assert.ok(finding?.fix, 'expected a fix when the base class is in the file');
  assert.match(finding.fix.changes.map((change: FixChange) => change.after).join('\n'), /private processMembers\(/);
});

test('a malformed package.json withholds only the TypeScript-private method fix', (context) => {
  const source = [
    'export class Drawing {',
    '  private line(a: number, b: number, c: number, d?: number, e?: number, scale = 2) {',
    '    return [a, b, c, d, e, scale];',
    '  }',
    '  render() { return [this.line(1, 2, 3, undefined), this.line(2, 3, 4, 5, 6, 7)]; }',
    '}',
    '',
  ].join('\n');
  const runtimePrivate = source.replace('private line', '#line').replaceAll('this.line', 'this.#line');
  const directory = project(context, {
    'package.json': '{"private": true,',
    'typed.ts': source,
    'runtime.ts': runtimePrivate,
  });
  const load = createFileCache(directory);
  const fixFor = (file: string) => {
    const loaded = load(file);
    assert.ok(loaded?.sourceFile);
    return buildFix(checkSizeLimits(loaded.sourceFile, file)[0], load);
  };
  assert.equal(fixFor('typed.ts'), undefined);
  assert.ok(fixFor('runtime.ts'), 'expected the runtime-private method to keep its fix');
});

const enumCycle = {
  'a.ts': "import { Color } from './b';\nexport const red = Color.Red;\nexport const one = 1;\n",
  'b.ts': "import { one } from './a';\nexport const enum Color {\n  Red = 1,\n}\nexport const twice = one * 2;\n",
};

test('dependency-cycle ignores an import of a const enum that TypeScript inlines', (context) => {
  const directory = project(context, { ...enumCycle, 'tsconfig.json': '{ "compilerOptions": { "strict": true } }' });
  assert.deepEqual(ruleFindings(directory, 'dependency-cycle'), []);
});

test('dependency-cycle still reports a const enum import that isolated modules keep', (context) => {
  const variants = [{ isolatedModules: true }, { verbatimModuleSyntax: true }, { preserveValueImports: true }];
  for (const compilerOptions of variants) {
    const directory = project(context, { ...enumCycle, 'tsconfig.json': JSON.stringify({ compilerOptions }) });
    assert.equal(ruleFindings(directory, 'dependency-cycle').length, 1, JSON.stringify(compilerOptions));
  }
});

test('dependency-cycle still reports a regular enum, a mixed import and a re-exported const enum', (context) => {
  const variants = {
    regular: { ...enumCycle, 'b.ts': enumCycle['b.ts'].replace('const enum', 'enum') },
    mixed: {
      ...enumCycle,
      'a.ts':
        "import { Color, twice } from './b';\nexport const red = Color.Red;\nexport const one = 1;\nexport const both = twice;\n",
    },
    reexported: {
      ...enumCycle,
      'a.ts': enumCycle['a.ts'].replace("'./b'", "'./c'"),
      'c.ts': "export { Color } from './b';\n",
    },
  };
  for (const [name, files] of Object.entries(variants)) {
    const directory = project(context, files);
    assert.equal(ruleFindings(directory, 'dependency-cycle').length, 1, name);
  }
});

test('declaration files record each top-level import and re-export once', () => {
  const ts: typeof Typescript = require('typescript');
  const text = [
    "import { Shape } from './shape';",
    "export { Color } from './color';",
    'export { Size };',
    "declare module './plugin' {",
    "  import { Hook } from './hook';",
    '}',
    'declare const Size: Shape;',
    '',
  ].join('\n');
  const sourceFile = ts.createSourceFile('/repo/types.d.ts', text, ts.ScriptTarget.Latest, true);
  const known = new Set(['shape.ts', 'color.ts', 'plugin.ts', 'hook.ts']);
  const resolve = (specifier: string) => [specifier.slice(2) + '.ts'].find((file) => known.has(file));
  const usage = collectModuleUsage(sourceFile, 'types.d.ts', resolve);
  assert.deepEqual(
    usage.imports.map((item) => item.to),
    ['shape.ts', 'plugin.ts', 'hook.ts'],
  );
  assert.deepEqual(
    usage.reexports.map((item) => item.to),
    ['color.ts'],
  );
  assert.deepEqual(
    usage.exports.map((item) => item.name),
    ['Size'],
  );
});
