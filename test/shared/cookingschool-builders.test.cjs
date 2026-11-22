'use strict';

// Regressions found by applying generated fixes to a NestJS + Drizzle backend.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { checkSizeLimits } = require('../../lib/maintainability/size-limits.cjs');
const { buildFix, createFileCache } = require('../../lib/maintainability/site-fix.cjs');
const { applyFix } = require('../../lib/maintainability/apply-fix.cjs');

function temporaryProject(context, files) {
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

function appliedText(fix, text) {
  const created = new Set(fix.changes.filter((change) => change.create).map((change) => change.file));
  let after;
  const result = applyFix(fix, {
    readFile: (file) => (created.has(file) ? '' : text),
    writeFile: (file, value) => {
      if (!created.has(file)) after = value;
    },
  });
  assert.equal(result.error, undefined);
  return after;
}

function parameterFix(context, text, extraFiles = {}) {
  const root = temporaryProject(context, { 'package.json': '{"private":true}', 'service.ts': text, ...extraFiles });
  const load = createFileCache(root);
  const finding = checkSizeLimits(load('service.ts').sourceFile, 'service.ts').find(
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

function closureSource(signature, call) {
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

function controlFlowRewrite(text, filename = 'products.ts') {
  const { analyzeFunctions } = require('../../lib/maintainability/functions.cjs');
  const build = require('../../lib/maintainability/site-fixes/control-flow.cjs')['deep-control-flow'];
  const sourceFile = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const finding = analyzeFunctions(sourceFile, filename).find((issue) => issue.ruleId === 'deep-control-flow');
  assert.ok(finding);
  const offset = sourceFile.getPositionOfLineAndCharacter(finding.line - 1, finding.column - 1);
  const result = build({ sourceFile, offset, node: ts.getTokenAtPosition(sourceFile, offset) });
  if (!result) return;
  for (const edit of result.edits.toSorted((left, right) => right.start - left.start))
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}

function imageLoop(declaration, condition) {
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

