'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { buildFix, createFileCache } = require('../../lib/maintainability/site-fix.cjs');
const cli = path.join(__dirname, '../../bin/loadwise.cjs');

function project(context, files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-improve-maint-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), content);
  }
  return directory;
}

function ruleFindings(directory, ruleId) {
  const result = spawnSync(process.execPath, [cli, 'maint', '--json', '--include-contextual'], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).findings.filter((finding) => finding.ruleId === ruleId);
}

// Points a finding at the first occurrence of `marker` in `file`, the way the scanner reports a declaration name.
function siteOf(directory, file, marker, occurrence = 0) {
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

function duplicateFix(context, copyBody, keptBody = sharedBody) {
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
  const finding = {
    ...siteOf(directory, 'day.mjs', 'sameDay'),
    ruleId: 'duplicate-implementation',
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
const tallyClass = (heading, signature = '  run(groups: Group[], out: Map<string, string>) {') =>
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

// A JavaScript file is not type-checked after the rewrite, so only the member check keeps the base method intact.
test('extracted method avoids a name a base class declares as a string member', (context) => {
  const base = ['class Base {', "  'processMembers'() {", '    return 1;', '  }', '}'];
  const tally = tallyClass([...base, 'export class Tally extends Base {'], '  run(groups, out) {');
  const directory = project(context, { 'tally.mjs': tally });
  const [finding] = ruleFindings(directory, 'deep-control-flow');
  assert.ok(finding, 'expected the deep loop to be reported');
  const added = (finding.fix?.changes ?? []).map((change) => change.after).join('\n');
  assert.doesNotMatch(added, /processMembers/);
});

test('extracted method still applies under a base class whose members are known', (context) => {
  const base = ['class Base {', '  label = 1;', '}'];
  const directory = project(context, {
    'tally.ts': tallyClass([groupType, ...base, 'export class Tally extends Base {']),
  });
  const [finding] = ruleFindings(directory, 'deep-control-flow');
  assert.ok(finding?.fix, 'expected a fix when the base class is in the file');
  assert.match(finding.fix.changes.map((change) => change.after).join('\n'), /private processMembers\(/);
});

