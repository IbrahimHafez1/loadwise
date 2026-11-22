'use strict';

// Corpus-driven fixes for array-repeated-membership, array-repeated-find and reduce-copy-accumulator: eager,
// readable lookups, typed Map keys, one shared lookup per array, outermost-loop placement and wrapped long lines.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

const membership = 'array-repeated-membership';
const find = 'array-repeated-find';
const reduceCopy = 'reduce-copy-accumulator';
const strictOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
};

function findingsFor(context, ruleId, source) {
  const scan = scanWithFixes(context, { 'app.ts': source });
  return { ...scan, findings: scan.findings.filter((finding) => finding.ruleId === ruleId) };
}

function changeFor(context, ruleId, source) {
  const { findings } = findingsFor(context, ruleId, source);
  assert.ok(findings[0], 'rule should report');
  return { change: onlyChange(findings[0]), note: findings[0].fix?.note };
}

// Applies every distinct fix of `findings` the way `--fix` does: findings sharing one change set apply it once.
function applyAll(source, findings) {
  const distinct = new Map();
  for (const finding of findings) {
    assert.ok(finding.fix, `${finding.ruleId} at line ${finding.line} should have a fix`);
    distinct.set(JSON.stringify(finding.fix.changes), finding.fix.changes);
  }
  let rewritten = source;
  for (const changes of distinct.values()) {
    for (const change of changes) {
      assert.ok(rewritten.includes(change.before), 'each change applies to the text left by the others');
      rewritten = rewritten.replace(change.before, () => change.after);
    }
  }
  return rewritten;
}

function compileErrors(root, source) {
  const target = path.join(root, 'fixed.ts');
  fs.writeFileSync(target, source);
  const program = ts.createProgram([target], strictOptions);
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

function run(source, name, ...args) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const exports = {};
  new Function('exports', compiled.outputText)(exports);
  return exports[name](...args);
}

test('includes on an unchanged local array builds the Set eagerly before the loop', (context) => {
  const { change, note } = changeFor(
    context,
    membership,
    `export function pick(rows: { id: number }[], allowedIds: number[]) {
  return rows.filter((row) => allowedIds.includes(row.id));
}`,
  );
  assert.deepEqual(change, {
    before: `return rows.filter((row) => allowedIds.includes(row.id));`,
    after: `const allowedIdsSet = new Set(allowedIds);
return rows.filter((row) => allowedIdsSet.has(row.id));`,
  });
  assert.match(note, /built once before the iteration/);
});

test('includes keeps the lazy Set for a property chain, whose early read could run a getter', (context) => {
  const { change, note } = changeFor(
    context,
    membership,
    `export function shared(rows: string[], team: { ids: string[] }) {
  return rows.filter((row) => team.ids.includes(row));
}`,
  );
  assert.deepEqual(change.after.split('\n'), [
    'const buildIdsSet = () => new Set(team.ids);',
    'let idsSet: ReturnType<typeof buildIdsSet>;',
    'return rows.filter((row) => (idsSet ??= buildIdsSet()).has(row));',
  ]);
  assert.match(note, /first membership check/);
});

test('find by a string key builds an inferred Map eagerly, without the NaN filter, keeping the first match', (context) => {
  const source = `interface Grade { id: string; name: string }
export function link(offerings: { gradeLevelId: string }[], grades: Grade[]) {
  return offerings.map((offering) => grades.find((row) => row.id === offering.gradeLevelId)?.name);
}`;
  const { root, findings } = findingsFor(context, find, source);
  const change = onlyChange(findings[0]);
  assert.deepEqual(change.after.split('\n'), [
    'const gradesById = new Map(grades.map((row) => [row.id, row] as const).reverse());',
    'return offerings.map((offering) => gradesById.get(offering.gradeLevelId)?.name);',
  ]);
  assert.match(findings[0].fix.note, /^The Map is built once before the iteration\. The first duplicate wins/);
  const fixed = applyAll(source, findings);
  assert.deepEqual(compileErrors(root, fixed), []);
  const offerings = [{ gradeLevelId: 'a' }, { gradeLevelId: 'b' }, { gradeLevelId: 'missing' }];
  const grades = [
    { id: 'a', name: 'first a' },
    { id: 'b', name: 'b' },
    { id: 'a', name: 'second a' },
  ];
  assert.deepEqual(run(fixed, 'link', offerings, grades), run(source, 'link', offerings, grades));
  assert.deepEqual(run(fixed, 'link', offerings, grades), ['first a', 'b', undefined]);
});

test('find types the Map key with the wider probe type instead of unknown', (context) => {
  const source = `interface Grade { id: string; name: string }
export function link(offerings: { gradeLevelId?: string }[], grades: Grade[]) {
  return offerings.map((offering) => grades.find((row) => row.id === offering.gradeLevelId)?.name);
}`;
  const { root, findings } = findingsFor(context, find, source);
  assert.deepEqual(onlyChange(findings[0]).after.split('\n').slice(0, 3), [
    'const gradesById = new Map<string | undefined, (typeof grades)[number]>(',
    '  grades.map((row) => [row.id, row] as const).reverse(),',
    ');',
  ]);
  assert.deepEqual(compileErrors(root, applyAll(source, findings)), []);
});

test('find by a numeric key keeps the NaN filter and wraps a long Map construction', (context) => {
  const source = `interface Membership { teamIdentifier: number; role: string }
export function roles(requestedTeamIdentifiers: number[], currentUserTeamMemberships: Membership[]) {
  return requestedTeamIdentifiers.map(
    (teamIdentifier) => currentUserTeamMemberships.find((membership) => membership.teamIdentifier === teamIdentifier)?.role,
  );
}`;
  const { root, findings } = findingsFor(context, find, source);
  const lines = onlyChange(findings[0]).after.split('\n');
  assert.deepEqual(lines.slice(0, 6), [
    'const currentUserTeamMembershipsByTeamIdentifier = new Map(',
    '  currentUserTeamMemberships',
    '    .map((membership) => [membership.teamIdentifier, membership] as const)',
    '    .filter(([key]) => !Number.isNaN(key))',
    '    .reverse(),',
    ');',
  ]);
  for (const line of lines.slice(0, 6)) assert.ok(line.length + 2 <= 100, line);
  const fixed = applyAll(source, findings);
  assert.deepEqual(compileErrors(root, fixed), []);
  const memberships = [
    { teamIdentifier: NaN, role: 'nan' },
    { teamIdentifier: 1, role: 'first' },
    { teamIdentifier: 1, role: 'second' },
  ];
  assert.deepEqual(run(fixed, 'roles', [1, NaN, 2], memberships), ['first', undefined, undefined]);
});

test('find keeps the lazy Map when reading the key early could run a getter', (context) => {
  const { change } = changeFor(
    context,
    find,
    `class Grade {
  constructor(private readonly raw: { id: string }) {}
  get id() { return this.raw.id; }
}
export function link(offerings: { gradeLevelId: string }[], grades: Grade[]) {
  return offerings.map((offering) => grades.find((row) => row.id === offering.gradeLevelId));
}`,
  );
  assert.match(change.after, /const buildGradesById = \(\) => new Map\(grades\.map/);
  assert.match(change.after, /\(gradesById \?\?= buildGradesById\(\)\)\.get\(offering\.gradeLevelId\)/);
});

test('two finds on one array in one function share one Map and apply together (k12 run-seed-grades)', (context) => {
  const source = `interface Grade { id: string; name: string }
export function seed(offerings: { gradeLevelId: string }[], classes: { gradeLevelId: string }[], grades: Grade[]) {
  const names: (string | undefined)[] = [];
  for (const offering of offerings) {
    const grade = grades.find((row) => row.id === offering.gradeLevelId);
    names.push(grade?.name);
  }
  const academic = {
    classes: classes.map((schoolClass) => {
      const grade = grades.find((row) => row.id === schoolClass.gradeLevelId);
      return grade?.name;
    }),
  };
  return { names, academic };
}`;
  const { root, findings } = findingsFor(context, find, source);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings[0].fix.changes, findings[1].fix.changes);
  const fixed = applyAll(source, findings);
  assert.equal(fixed.match(/const gradesById = /g).length, 1);
  assert.deepEqual(compileErrors(root, fixed), []);
  const grades = [
    { id: 'a', name: 'first' },
    { id: 'a', name: 'second' },
  ];
  const offerings = [{ gradeLevelId: 'a' }];
  assert.deepEqual(run(fixed, 'seed', offerings, offerings, grades), run(source, 'seed', offerings, offerings, grades));
});

test('two includes on one array in one callback apply together (directus relations)', (context) => {
  const source = `interface Relation { collection: string; related_collection: string | null }
export function visible(relations: Relation[], allowedCollections: string[]) {
  return relations.filter((relation) => {
    if (allowedCollections.includes(relation.collection) === false) {
      return false;
    }
    if (relation.related_collection && allowedCollections.includes(relation.related_collection) === false) {
      return false;
    }
    return true;
  });
}`;
  const { root, findings } = findingsFor(context, membership, source);
  assert.equal(findings.length, 2);
  const fixed = applyAll(source, findings);
  assert.equal(fixed.match(/const allowedCollectionsSet = new Set\(allowedCollections\);/g).length, 1);
  assert.deepEqual(compileErrors(root, fixed), []);
});

test('includes on two arrays ending in the same property get distinct Set names', (context) => {
  const source = `export function shared(keys: string[], left: { ids: string[] }, right: { ids: string[] }) {
  const all = keys.every((key) => left.ids.includes(key));
  const any = keys.some((key) => right.ids.includes(key));
  return all && any;
}`;
  const { root, findings } = findingsFor(context, membership, source);
  assert.equal(findings.length, 2);
  const fixed = applyAll(source, findings);
  assert.match(fixed, /const buildLeftIdsSet = \(\) => new Set\(left\.ids\);/);
  assert.match(fixed, /const buildRightIdsSet = \(\) => new Set\(right\.ids\);/);
  assert.deepEqual(compileErrors(root, fixed), []);
});

test('find in a nested loop builds the Map before the outermost loop that leaves the array unchanged', (context) => {
  const source = `interface Key { key: string; dataType: string }
export function types(contacts: { attributes: { key: string }[] }[], existingAttributeKeys: Key[]) {
  const found: (string | undefined)[] = [];
  for (const contact of contacts) {
    for (const attribute of contact.attributes) {
      found.push(existingAttributeKeys.find((existing) => existing.key === attribute.key)?.dataType);
    }
  }
  return found;
}`;
  const { root, findings } = findingsFor(context, find, source);
  const { before, after } = onlyChange(findings[0]);
  assert.ok(before.startsWith('for (const contact of contacts) {'), before);
  assert.ok(after.startsWith('const existingAttributeKeysByKey = new Map('), after);
  assert.deepEqual(compileErrors(root, applyAll(source, findings)), []);
  const { findings: touched } = findingsFor(
    context,
    find,
    `interface Key { key: string; dataType: string }
declare function touch(keys: Key[]): void;
export function types(contacts: { attributes: { key: string }[] }[], keys: Key[]) {
  for (const contact of contacts) {
    touch(keys);
    for (const attribute of contact.attributes) keys.find((existing) => existing.key === attribute.key);
  }
}`,
  );
  assert.deepEqual(onlyChange(touched[0]), {
    before: 'for (const attribute of contact.attributes) keys.find((existing) => existing.key === attribute.key);',
    after: `const keysByKey = new Map(keys.map((existing) => [existing.key, existing] as const).reverse());
for (const attribute of contact.attributes) keysByKey.get(attribute.key);`,
  });
});

test('reduce object spread keeps no fix when the accumulator is an untyped {} in TypeScript', (context) => {
  const untyped = findingsFor(
    context,
    reduceCopy,
    `export function labels(items: { id: string; label: string }[]) {
  return items.reduce((prev, curr) => ({ ...prev, [curr.id]: curr.label }), {}) as Record<string, string>;
}`,
  ).findings;
  assert.ok(untyped.length > 0, 'rule should report');
  assert.deepEqual(
    untyped.map((finding) => finding.fix),
    untyped.map(() => undefined),
  );
  const source = `export function labels(items: { id: string; label: string }[]) {
  return items.reduce((prev, curr) => ({ ...prev, [curr.id]: curr.label }), {} as Record<string, string>);
}`;
  const { root, findings } = findingsFor(context, reduceCopy, source);
  assert.deepEqual(compileErrors(root, applyAll(source, findings)), []);
});
