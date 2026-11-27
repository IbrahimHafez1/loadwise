// Markup-file behaviour around the parser limits, the per-folder caches, generated folders and review comments.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { hasFrontendSources } from '../../lib/accessibility/frontend-detect.js';
import { scanMarkupFiles } from '../../lib/accessibility/markup-files.js';
import type { MarkupElement } from '../../lib/accessibility/markup.js';
import { checkMarkup } from '../../lib/accessibility/rules.js';
import { templateDocument } from '../../lib/accessibility/template-elements.js';
import { checkTemplateFile } from '../../lib/accessibility/template-file.js';

const missingAltRuleId = 'a11y-img-missing-alt';
const maxExpectedDepth = 502;

function createDirectory(context: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-a11y-extra-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function missingAltLines(file: string, text: string): (number | undefined)[] {
  return checkTemplateFile(file, text)
    .filter((finding) => finding.ruleId === missingAltRuleId)
    .map((finding) => finding.line);
}

function nestingDepth(elements: readonly MarkupElement[]): number {
  let depth = 0;
  for (let level = elements; level.length; level = level[level.length - 1].children) depth++;
  return depth;
}

test('loadwise-reviewed comments dismiss markup findings on the line above or the same line', () => {
  const above = '<!-- loadwise-reviewed a11y-img-missing-alt -- decorative sprite -->\n<img src="a">';
  const sameLine = '<img src="a"> <!-- loadwise-reviewed a11y-img-missing-alt -- decorative sprite -->';
  for (const text of [above, sameLine]) {
    const finding = checkTemplateFile('page.html', text).find((candidate) => candidate.ruleId === missingAltRuleId);
    assert.equal(finding?.contextualReason, 'Reviewed in source: decorative sprite');
  }
  const otherRule = '<!-- loadwise-reviewed a11y-button-name -- not this one -->\n<img src="a">';
  const unrelated = checkTemplateFile('page.html', otherRule).find(
    (candidate) => candidate.ruleId === missingAltRuleId,
  );
  assert.ok(unrelated);
  assert.equal(unrelated.contextualReason, undefined);
  const vue =
    '<template>\n  <!-- loadwise-reviewed a11y-img-missing-alt -- decorative -->\n  <img src="a">\n</template>';
  assert.equal(checkTemplateFile('Sample.vue', vue)[0]?.contextualReason, 'Reviewed in source: decorative');
});

test('a "do not edit" note in page text after a comment does not mark the page as generated', () => {
  const handWritten = ['<!-- header -->', '<p>Please do not edit this --> sample</p>', '<img src="a">'].join('\n');
  assert.deepEqual(missingAltLines('page.html', handWritten), [3]);
  assert.deepEqual(missingAltLines('page.html', '<!-- do not edit -->\n<img src="a">'), []);
});

test('thousands of unclosed elements parse with bounded nesting', () => {
  const document = templateDocument('deep.html', '<div>'.repeat(10_000) + '<img src="a">', 'html');
  assert.ok(nestingDepth(document.roots) <= maxExpectedDepth);
  assert.doesNotThrow(() => checkMarkup(document));
});

test('unmatched braces and interpolation openers parse in linear time', () => {
  const started = Date.now();
  templateDocument('Many.svelte', '<p>' + '{ '.repeat(100_000) + '</p>', 'svelte');
  templateDocument('many.html', '<p>' + '{{ x '.repeat(100_000) + '</p>', 'html');
  assert.ok(Date.now() - started < 5000);
});

test('sibling templateUrl lookups are read once per folder', (context) => {
  const directory = createDirectory(context);
  const scriptPath = path.join(directory, 'card.ts');
  fs.writeFileSync(scriptPath, "@Component({ templateUrl: './card.html' }) class Card {}");
  const templatePath = path.join(directory, 'card.html');
  const markup = '<img [alt]="label" src="a.png">';
  assert.deepEqual(missingAltLines(templatePath, markup), []);
  fs.writeFileSync(scriptPath, 'export {};');
  assert.deepEqual(missingAltLines(templatePath, markup), [], 'the folder listing was cached');
});

test('generated and report folders are excluded at any depth', (context) => {
  const directory = createDirectory(context);
  const markup = '<img src="a">';
  for (const folder of ['src', 'packages/web/coverage', 'docs/_build', 'site']) {
    fs.mkdirSync(path.join(directory, folder), { recursive: true });
    fs.writeFileSync(path.join(directory, folder, 'page.html'), markup);
  }
  assert.equal(scanMarkupFiles({ roots: [directory], explicitFiles: [] }).scannedFiles, 1);
  assert.equal(hasFrontendSources(directory), true);
  const reportsOnly = createDirectory(context);
  fs.mkdirSync(path.join(reportsOnly, 'packages', 'api', 'htmlcov'), { recursive: true });
  fs.writeFileSync(path.join(reportsOnly, 'packages', 'api', 'htmlcov', 'index.html'), markup);
  assert.equal(hasFrontendSources(reportsOnly), false);
});

test('source folders that share a name with build output are scanned below the root', (context) => {
  const directory = createDirectory(context);
  for (const folder of ['apps/site', 'src/out']) {
    fs.mkdirSync(path.join(directory, folder), { recursive: true });
    fs.writeFileSync(path.join(directory, folder, 'page.html'), '<img src="a">');
  }
  assert.equal(scanMarkupFiles({ roots: [directory], explicitFiles: [] }).scannedFiles, 2);
});

test('an unreadable explicit markup file is skipped with a note instead of aborting', (context) => {
  const note = context.mock.method(console, 'error', () => undefined);
  const missing = path.join(os.tmpdir(), 'loadwise-a11y-missing-file.html');
  const result = scanMarkupFiles({ roots: [], explicitFiles: [missing] });
  assert.equal(result.scannedFiles, 0);
  assert.equal(result.skippedFiles?.length, 1);
  assert.match(String(note.mock.calls[0]?.arguments[0]), /Skipped that file/);
});
