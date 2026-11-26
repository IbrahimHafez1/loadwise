// Regressions found by applying generated fixes to a NestJS + Drizzle backend.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { checkSizeLimits } from '../../lib/maintainability/size-limits.js';
import { buildFix, createFileCache } from '../../lib/maintainability/site-fix.js';
import { applyFix } from '../../lib/maintainability/apply-fix.js';
import type { FindingFix, FixChange, SiteFixInput } from '../../lib/shared/types.js';
import type { TestContext } from 'node:test';
import type { FileMap } from '../types/project-files.js';
import { analyzeFunctions } from '../../lib/maintainability/functions.js';
import { checkSwallowedErrors } from '../../lib/maintainability/swallowed-errors.js';
import { scanWithFixes, withSecurity } from '../performance/site-fix-helpers.js';
import * as performanceFix from '../../lib/performance/site-fix.js';

await performanceFix.loadBuilders();
import controlFlow from '../../lib/maintainability/site-fixes/control-flow.js';

function temporaryProject(context: TestContext, files: FileMap) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'loadwise-cookingschool-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

function appliedText(fix: FindingFix | undefined, text: string) {
  assert.ok(fix, 'the builder should offer a fix');
  const created = new Set(
    fix.changes.filter((change: FixChange) => change.create).map((change: FixChange) => change.file),
  );
  const writtenTexts: string[] = [];
  const result = applyFix(fix, {
    readFile: (file: string) => (created.has(file) ? '' : text),
    writeFile: (file: string, value: string) => {
      if (!created.has(file)) writtenTexts.push(value);
    },
  });
  assert.equal(result.error, undefined);
  const after = writtenTexts.at(-1);
  assert.ok(after !== undefined, 'the fix should write the edited file');
  return after;
}

function parameterFix(context: TestContext, text: string, extraFiles: FileMap = {}) {
  const root = temporaryProject(context, { 'package.json': '{"private":true}', 'service.ts': text, ...extraFiles });
  const load = createFileCache(root);
  const loaded = load('service.ts');
  assert.ok(loaded?.sourceFile);
  const finding = checkSizeLimits(loaded.sourceFile, 'service.ts').find(
    (candidate) => candidate.ruleId === 'long-parameter-list',
  );
  assert.ok(finding);
  return buildFix(finding, load);
}

const calendarService = [
  'export class CalendarService {',
  '  async list(startDate: string, endDate: string, eventType?: string, chefId?: number) {',
  '    return this.collect(startDate, endDate, eventType, 1, chefId, true);',
  '  }',
  '  async dashboard(start: string, end: string, chefId: number) {',
  '    return this.collect(start, end, undefined, undefined, chefId);',
  '  }',
  '  private async collect(',
  '    startDate: string,',
  '    endDate: string,',
  '    eventType?: string,',
  '    locationId?: number | number[],',
  '    chefId?: number,',
  '    includeDetails = false,',
  '  ) {',
  '    return [startDate, endDate, eventType, locationId, chefId, includeDetails];',
  '  }',
  '}',
].join('\n');

test('long-parameter-list writes optional members, omits literal undefined and groups trailing positions', (context) => {
  const fix = parameterFix(context, calendarService);
  assert.ok(fix);
  const after = appliedText(fix, calendarService);
  assert.match(after, /eventType\?: string;/);
  assert.match(after, /locationId\?: number \| number\[\];/);
  assert.match(after, /includeDetails\?: boolean;/);
  assert.match(after, /\{ startDate, endDate, eventType, locationId, chefId, includeDetails = false \}/);
  assert.doesNotMatch(after, /\) \| undefined|: undefined/);
  assert.match(after, /this\.collect\(\{ startDate: start, endDate: end, chefId \}\)/);
  assert.match(after, /eventType, locationId: 1, chefId, includeDetails: true \}\)/);
});

test('long-parameter-list keeps an explicit undefined member under exactOptionalPropertyTypes', (context) => {
  const tsconfig = '{ "compilerOptions": { "exactOptionalPropertyTypes": true } }';
  const after = appliedText(parameterFix(context, calendarService, { 'tsconfig.json': tsconfig }), calendarService);
  assert.match(after, /eventType\?: string \| undefined;/);
});

function closureSource(signature: string, call: string) {
  return [
    'export function render() {',
    '  const draw = (' + signature + ') => [a, b, c, d, e, f];',
    '  return draw(' + call + ');',
    '}',
  ].join('\n');
}

test('long-parameter-list offers no fix for a closure whose parameter types cannot be swapped', (context) => {
  const distinct = closureSource(
    'a: string, b: number, c: boolean, d: Date, e: RegExp, f: bigint',
    "'x', 1, true, new Date(), /y/, 1n",
  );
  assert.equal(parameterFix(context, distinct), undefined);
  const swappable = closureSource(
    'a: string, b: number, c: boolean, d: number, e: RegExp, f: bigint',
    "'x', 1, true, 2, /y/, 1n",
  );
  assert.ok(parameterFix(context, swappable));
});

function controlFlowRewrite(text: string, filename = 'products.ts'): string {
  const build = controlFlow['deep-control-flow'];
  const sourceFile = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const finding = analyzeFunctions(sourceFile, filename).find((issue) => issue.ruleId === 'deep-control-flow');
  assert.ok(finding && finding.line !== undefined && finding.column !== undefined);
  const offset = sourceFile.getPositionOfLineAndCharacter(finding.line - 1, finding.column - 1);
  // The builder registry passes the offset of the finding, which SiteFixInput does not declare.
  const input: SiteFixInput & { offset: number } = {
    finding,
    load: () => null,
    sourceFile,
    offset,
    node: ts.getTokenAtPosition(sourceFile, offset),
  };
  const result = build(input);
  assert.ok(result?.edits, 'the builder should offer a rewrite');
  for (const edit of result.edits.toSorted((left, right) => right.start - left.start))
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}

function imageLoop(declaration: string, condition: string) {
  return [
    'export function attach(rows: string[], images: Map<string, ' + declaration + '>, sink: string[]) {',
    '  for (const sku of rows) {',
    '    const rowImages = images.get(sku);',
    '    if (' + condition + ') {',
    '      for (const image of rowImages.slice(0, 4)) {',
    '        if (image) sink.push(image);',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

test('deep-control-flow guards negate a length test without a negated comparison', () => {
  const merged = controlFlowRewrite(imageLoop('string[]', 'rowImages && rowImages.length > 0'));
  assert.match(merged, /if \(!rowImages\?\.length\) continue;/);
  const flipped = controlFlowRewrite(imageLoop('string[]', 'sku && rowImages!.length > 0'));
  assert.match(flipped, /if \(!sku \|\| rowImages!\.length <= 0\) continue;/);
});

test('deep-control-flow guards keep a negated comparison when the operand may be NaN or untyped', () => {
  const numeric = controlFlowRewrite(imageLoop('string[]', 'rowImages && Number(sku) > 0'));
  assert.match(numeric, /if \(!rowImages \|\| !\(Number\(sku\) > 0\)\) continue;/);
  const untyped = controlFlowRewrite(imageLoop('Unresolved', 'rowImages && rowImages.length > 0'));
  assert.match(untyped, /if \(!rowImages \|\| !\(rowImages\.length > 0\)\) continue;/);
});

const packetRecord = [
  'interface Packet {',
  ...Array.from({ length: 21 }, (_, index) => `  field${index}: string;`),
  '}',
].join('\n');
const packetModule = [
  "import { Injectable } from '@nestjs/common';",
  "import { helper } from './helper';",
  '',
  packetRecord,
  '',
  'export function inspect(packet: Packet) { return helper(packet.field0); }',
  '',
].join('\n');

function largeModuleFix(context: TestContext, text: string, linesOfCode: number) {
  const root = temporaryProject(context, { 'package.json': '{}', 'api.ts': text });
  const message = `This module has ${linesOfCode} lines of code (limit 600, comments and blank lines excluded).`;
  return buildFix({ file: 'api.ts', line: 1, column: 1, ruleId: 'large-module', message }, createFileCache(root));
}

test('large-module imports the record in the import block with the neighbouring extension style', (context) => {
  const fix = largeModuleFix(context, packetModule, 610);
  assert.ok(fix);
  const after = appliedText(fix, packetModule);
  assert.ok(
    after.startsWith(
      "import { Injectable } from '@nestjs/common';\nimport { helper } from './helper';\n" +
        "import type { Packet } from './api.types';\n\nexport function inspect",
    ),
    after,
  );
  const constants = ['const first = 1;', 'const second = 2;', 'const third = 3;', 'const fourth = 4;'].join('\n');
  const distant = packetModule.replace('\n\ninterface', '\n\n' + constants + '\ninterface');
  const distantAfter = appliedText(largeModuleFix(context, distant, 610), distant);
  assert.match(
    distantAfter,
    /common';\n\/\/ Loadwise large-module[^\n]*\n(?:\/\/[^\n]*\n)*import type \{ Packet \} from '\.\/api\.types';\nimport \{ helper \}/,
  );
  assert.match(distantAfter, /const fourth = 4;\n\nexport function inspect/);
  const esmModule = packetModule.replace("'./helper'", "'./helper.js'");
  assert.match(appliedText(largeModuleFix(context, esmModule, 610), esmModule), /from '\.\/api\.types\.js';/);
});

test('large-module keeps a record whose move leaves the module over the line limit', (context) => {
  assert.equal(largeModuleFix(context, packetModule, 1700), undefined);
});

function seedStore(loopBody: string) {
  return [
    "'use strict';",
    "const assert = require('node:assert');",
    'class Store {',
    '  save(rows, existing, registryKey) {',
    '    for (const row of rows) {',
    '      if (row.owned) {',
    '        if (existing.length) {',
    '          if (row.checked) {',
    '            for (const [field, value] of Object.entries(row.identity))',
    '              ' + loopBody,
    '          }',
    '          row.count++;',
    '        }',
    '      }',
    '    }',
    '  }',
    '}',
    'module.exports = { Store };',
  ].join('\n');
}

test('deep-control-flow names an extracted loop that only asserts after what it checks', () => {
  const asserting = controlFlowRewrite(
    seedStore('assert.equal(existing[0][field], value, `Seed ownership changed: ${registryKey}`);'),
    'seed.cjs',
  );
  assert.match(asserting, /this\.assertChecked\(/);
  const updating = controlFlowRewrite(seedStore('existing[0][field] = value;'), 'seed.cjs');
  assert.match(updating, /this\.handleChecked\(/);
});

function swallowedLines(source: string) {
  const sourceFile = ts.createSourceFile('src/example.ts', source, ts.ScriptTarget.Latest, true);
  return checkSwallowedErrors(sourceFile, 'src/example.ts').map((finding) => finding.line);
}

test('swallowed-error accepts a catch that keeps a declared default or returns the empty result', () => {
  const fallbackFont = [
    'async function fonts(document) {',
    '  let font = document.standard;',
    '  try {',
    '    font = await document.embed(read());',
    '  } catch (error) {',
    '    logger.warn("embed failed", error);',
    '  }',
    '  return draw(font);',
    '}',
  ].join('\n');
  assert.deepEqual(swallowedLines(fallbackFont), []);
  for (const empty of ['null', 'undefined', 'false'])
    assert.deepEqual(
      swallowedLines(
        `function parse(text) {\n  try {\n    return new URL(text).pathname;\n  } catch {}\n  return ${empty};\n}`,
      ),
      [],
    );
  const explained = [
    'async function register(user) {',
    '  // Non-blocking: registration succeeds even if the email fails.',
    '  try {',
    '    await mail.send(user);',
    '  } catch (error) {',
    '    logger.warn(error);',
    '  }',
    '  return user;',
    '}',
  ].join('\n');
  assert.deepEqual(swallowedLines(explained), []);
});

test('swallowed-error still reports a catch that hides an error with no default or empty result', () => {
  const noDefault = [
    'async function fonts(document) {',
    '  let font;',
    '  try {',
    '    font = await document.embed(read());',
    '  } catch (error) {',
    '    logger.warn("embed failed", error);',
    '  }',
    '  return draw(font);',
    '}',
  ].join('\n');
  assert.deepEqual(swallowedLines(noDefault), [5]);
  const moreWork = noDefault
    .replace('let font;', 'let font = document.standard;')
    .replace('    font = await', '    await audit();\n    font = await');
  assert.deepEqual(swallowedLines(moreWork), [6]);
  assert.deepEqual(
    swallowedLines('function parse(text) {\n  try {\n    save(text);\n  } catch {}\n  return text;\n}'),
    [4],
  );
});

function tlsFix(context: TestContext, optionLine: string) {
  const source = ['export const config = {', '  ssl: {', '    ' + optionLine, '  },', '};', ''].join('\n');
  const { findings } = scanWithFixes(context, { 'drizzle.config.ts': source }, { analyzers: withSecurity });
  const [finding] = findings.filter((candidate) => candidate.ruleId === 'tls-verification-disabled');
  assert.ok(finding?.fix);
  return finding.fix;
}

test('tls-verification-disabled drops the same-line comment that described the disabled value', (context) => {
  const fix = tlsFix(context, 'rejectUnauthorized: false, // Or true, depending on your CA setup');
  assert.equal(fix.changes[0].after.trim(), 'rejectUnauthorized: true,');
  assert.ok(fix.note);
  assert.match(fix.note, /Removes the comment/);
});

test('tls-verification-disabled keeps a comment on its own line above the option', (context) => {
  const fix = tlsFix(context, '// Managed database CA\n    rejectUnauthorized: false,');
  assert.match(fix.changes.map((change: FixChange) => change.after).join('\n'), /^\s*rejectUnauthorized: true,$/m);
  assert.ok(fix.note);
  assert.doesNotMatch(fix.note, /Removes the comment/);
});

const diplomaTable = [
  "import { mysqlTable, index, int, varchar } from 'drizzle-orm/mysql-core';",
  'export const diplomas = mysqlTable(',
  "  'diplomas',",
  "  { id: int('id'), status: varchar('status', { length: 50 }), createdAt: int('created_at') },",
  '  (table) => [',
  "    index('status_idx').on(table.status),",
  '  ],',
  ');',
  '',
].join('\n');

function drizzleIndexNote(context: TestContext, files: FileMap) {
  const root = temporaryProject(context, { 'package.json': '{}', 'query.ts': 'export const run = 1;\n', ...files });
  const finding = {
    ruleId: 'index-missing-filter',
    file: path.join(root, 'query.ts'),
    line: 1,
    column: 8,
    message: '',
    suggestion: "index('diplomas_status_created_at_idx').on(table.status, table.createdAt)",
    related: [
      {
        file: path.join(root, 'schema/diploma.schema.ts'),
        line: 2,
        column: 25,
        message: 'Table `diplomas` is declared here.',
      },
    ],
  };
  const fix = performanceFix.buildFix(finding, performanceFix.createFileCache());
  assert.equal(fix?.requiresReview, true);
  assert.ok(fix?.note);
  return fix.note;
}

const drizzleKitConfig =
  "import type { Config } from 'drizzle-kit';\nexport default { out: './drizzle' } satisfies Config;\n";

test('drizzle index fix asks for a hand-written migration and names the index it makes redundant', (context) => {
  const note = drizzleIndexNote(context, {
    'schema/diploma.schema.ts': diplomaTable,
    'drizzle.config.ts': drizzleKitConfig,
    'schema/drizzle.config.ts': 'export const runtime = true;\n',
  });
  assert.match(note, /no drizzle-kit migrations folder/);
  assert.match(note, /`status_idx` becomes redundant/);
});

test('drizzle index fix leaves the migration to drizzle-kit and keeps unrelated indexes', (context) => {
  const note = drizzleIndexNote(context, {
    'schema/diploma.schema.ts': diplomaTable.replace('on(table.status)', 'on(table.createdAt)'),
    'drizzle.config.ts': drizzleKitConfig,
    'drizzle/0000_init.sql': 'CREATE TABLE diplomas (id int);\n',
  });
  assert.doesNotMatch(note, /migrations folder|redundant/);
});
