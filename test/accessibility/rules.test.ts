import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import ts from 'typescript';
import { jsxDocument } from '../../lib/accessibility/jsx-elements.js';
import { checkMarkup } from '../../lib/accessibility/rules.js';
import buttonFixes from '../../lib/accessibility/site-fixes/buttons.js';
import { createFileCache } from '../../lib/performance/site-fix.js';
import type { Finding } from '../../lib/shared/types.js';

function check(jsx: string, file = 'src/App.tsx'): Finding[] {
  const sourceFile = ts.createSourceFile(
    file,
    `const view = (${jsx});`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  return checkMarkup(jsxDocument(sourceFile, file));
}

function ruleIds(jsx: string): string[] {
  return check(jsx).map(({ ruleId }) => ruleId);
}

function assertFlags(ruleId: string, samples: readonly string[]): void {
  for (const sample of samples) assert.deepEqual(ruleIds(sample), [ruleId], sample);
}

function assertSilent(samples: readonly string[]): void {
  for (const sample of samples) assert.deepEqual(ruleIds(sample), [], sample);
}

test('findings carry the document file and a 1-based position', () => {
  const [finding] = check('<img src="a.png" />');
  assert.equal(finding.file, 'src/App.tsx');
  assert.deepEqual([finding.line, finding.column], [1, 15]);
});

test('img-missing-alt flags img, area and image inputs without alt', () => {
  assertFlags('a11y-img-missing-alt', [
    '<img src="a.png" />',
    '<img src={logo} />',
    '<area href="/x" />',
    '<input type="image" src="go.png" />',
  ]);
});

test('img-missing-alt accepts alt, decorative markup, hidden images, spreads and components', () => {
  assertSilent([
    '<img alt="Logo" />',
    '<img alt="" />',
    '<img alt={text} />',
    '<img aria-label="Logo" />',
    '<img aria-labelledby="caption" />',
    '<img role="presentation" />',
    '<img role="none" />',
    '<img aria-hidden="true" />',
    '<img {...props} />',
    '<Image src="a.png" />',
    '<input type="text" aria-label="Name" />',
    '<area alt="Map" href="/x" />',
  ]);
});

test('button-missing-type flags a typeless button with a click handler inside a form only', () => {
  assertFlags('a11y-button-missing-type', [
    '<form><button onClick={addRow}>Add</button></form>',
    '<form><div><button onClick={save} /></div></form>',
    '<button form="checkout" onClick={track}>Save</button>',
  ]);
  assertSilent([
    '<button onClick={save}>Save</button>',
    '<form onSubmit={save}><button>Save</button></form>',
    '<form><button type="button">Save</button></form>',
    '<form><button type={kind}>Save</button></form>',
    '<form><button {...props}>Save</button></form>',
    '<form><button disabled onClick={save}>Save</button></form>',
    '<form><button disabled="" onClick={save}>Save</button></form>',
    '<form><Button>Save</Button></form>',
  ]);
});

test('clickable-non-interactive flags a click handler with no role and no key handler', () => {
  assertFlags('a11y-clickable-non-interactive', [
    '<div onClick={open}>Open</div>',
    '<span onClick={open}>Open</span>',
    '<li onClick={open}>Open</li>',
    '<img alt="" onClick={open} />',
  ]);
});

test('clickable-non-interactive accepts roles, key handlers, native controls, hidden elements and spreads', () => {
  assertSilent([
    '<div onClick={(event) => event.stopPropagation()} />',
    '<div onClick={() => {}} />',
    '<div onClick={function () {}} />',
    '<div onClick={(event) => { event.preventDefault(); event.stopPropagation(); }} />',
    '<div role="button" onClick={open} />',
    '<div role={role} onClick={open} />',
    '<div onClick={open} onKeyDown={key} />',
    '<div onClick={open} onKeyUp={key} />',
    '<div onClick={open} onKeyPress={key} />',
    '<div onClick={open} aria-hidden="true" />',
    '<div onClick={open} {...props} />',
    '<div>Static</div>',
    '<a onClick={open} href="/x">Open</a>',
    '<button type="button" onClick={open}>Open</button>',
    '<label onClick={open}>Name</label>',
    '<summary onClick={open}>More</summary>',
    '<Card onClick={open} />',
  ]);
});

test('invalid-aria flags unknown aria attributes with a suggestion', () => {
  const [finding] = check('<div aria-lable="Name" />');
  assert.equal(finding.ruleId, 'a11y-invalid-aria');
  assert.match(finding.message, /"aria-lable"/);
  assert.match(finding.message, /Did you mean "aria-label"\?/);
  assert.equal(check('<div aria-banana="x" />')[0].message.includes('Did you mean'), false);
});

test('invalid-aria flags a role with no valid token and suggests the nearest role', () => {
  const [finding] = check('<div role="buton" />');
  assert.equal(finding.ruleId, 'a11y-invalid-aria');
  assert.match(finding.message, /Did you mean "button"\?/);
  assertFlags('a11y-invalid-aria', ['<div role="widget" />', '<div role="foo bar" />']);
});

test('invalid-aria accepts valid names, role fallbacks, DPUB and graphics roles, dynamic values and components', () => {
  assertSilent([
    '<div aria-label="x" aria-hidden="true" aria-labelledby="a" aria-describedby="b" aria-description="c" />',
    '<div role="button" />',
    '<div role="presentation" />',
    '<div role="none" />',
    '<div role="img" />',
    '<div role="doc-toc" />',
    '<div role="graphics-symbol" />',
    '<div role="widget button" />',
    '<div role="link foo" />',
    '<div role={role} />',
    '<div role="" />',
    '<Foo aria-banana="x" role="nope" />',
  ]);
});

test('missing-form-label flags unlabelled controls', () => {
  assertFlags('a11y-missing-form-label', [
    '<input type="text" />',
    '<input />',
    '<input placeholder="Name" />',
    '<select />',
    '<textarea />',
    '<div><label htmlFor="other">Other</label><input id="name" /></div>',
  ]);
});

test('missing-form-label accepts names, wrapping labels, label for ids and uncertain cases', () => {
  assertSilent([
    '<input aria-label="Name" />',
    '<input aria-labelledby="name-label" />',
    '<input title="Name" />',
    '<label>Name <input /></label>',
    '<label><span>Name</span><div><input /></div></label>',
    '<div><label htmlFor="name">Name</label><input id="name" /></div>',
    '<div><input id="name" /><label htmlFor="name">Name</label></div>',
    '<div><label htmlFor={id}>Name</label><input id="other" /></div>',
    '<div><label htmlFor="name">Name</label><input id={id} /></div>',
    '<input {...props} />',
    '<Field><input /></Field>',
    '<input type="hidden" />',
    '<input type="file" hidden />',
    '<input type="text" aria-hidden="true" tabIndex={-1} />',
    '<input role="presentation" />',
    '<input role="none" />',
    '<slot><input /></slot>',
    '<input type="submit" />',
    '<input type="button" />',
    '<input type="reset" />',
    '<input type="image" alt="Go" />',
    '<input type={kind} />',
    '<Input />',
    '<input id="email" type="email" />',
  ]);
});

test('html-missing-lang flags a missing or empty lang', () => {
  assertFlags('a11y-html-missing-lang', ['<html><body /></html>', '<html lang="" />']);
  assertSilent(['<html lang="en" />', '<html lang={locale} />', '<html {...props} />', '<Html />']);
});

test('iframe-missing-title flags an iframe without a name', () => {
  assertFlags('a11y-iframe-missing-title', ['<iframe src="/x" />']);
  assertSilent([
    '<iframe title="Map" />',
    '<iframe title={name} />',
    '<iframe aria-label="Map" />',
    '<iframe aria-labelledby="map" />',
    '<iframe aria-hidden="true" />',
    '<iframe {...props} />',
  ]);
});

test('positive-tabindex flags static values above zero', () => {
  assertFlags('a11y-positive-tabindex', [
    '<div tabIndex={1} />',
    '<div tabIndex="3" />',
    '<button type="button" tabIndex={10} />',
  ]);
  assertSilent(['<div tabIndex={0} />', '<div tabIndex={-1} />', '<div tabIndex={order} />', '<Item tabIndex={2} />']);
});

test('viewport-zoom-disabled flags blocked or tightly limited zoom', () => {
  assertFlags('a11y-viewport-zoom-disabled', [
    '<meta name="viewport" content="width=device-width, user-scalable=no" />',
    '<meta name="viewport" content="width=device-width,user-scalable=0" />',
    '<meta name="viewport" content="width=device-width; maximum-scale=1" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1.0" />',
    '<meta name="viewport" content="user-scalable = no" />',
  ]);
  assertSilent([
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta name="viewport" content="width=device-width, user-scalable=yes, maximum-scale=5" />',
    '<meta name="viewport" content="width=device-width, maximum-scale=2" />',
    '<meta name="viewport" content={content} />',
    '<meta name="description" content="user-scalable=no" />',
  ]);
});

function fixFixture(context: TestContext, source: string, fileName: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-a11y-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, fileName);
  fs.writeFileSync(file, source);
  const finding: Finding = { file, line: 2, column: 3, ruleId: 'a11y-button-missing-type', message: '' };
  const load = createFileCache();
  const build = buttonFixes['a11y-button-missing-type'];
  return build({ finding, load, text: load(file)?.text });
}

test('button type fix inserts type="button" after the tag name in a tsx file', (context) => {
  const source = 'const a = (\n  <button onClick={save}>Save</button>\n);\n';
  const result = fixFixture(context, source, 'view.tsx');
  assert.ok(result?.edits);
  const [edit] = result.edits;
  assert.equal(
    source.slice(0, edit.start) + edit.text + source.slice(edit.end),
    source.replace('<button', '<button type="button"'),
  );
  assert.equal(result.requiresReview, true);
  assert.match(result.note ?? '', /type="submit"/);
});

test('button type fix works on html text and rejects a position that is not a button', (context) => {
  const html = '<form>\n  <button class="go">Go</button>\n</form>\n';
  const result = fixFixture(context, html, 'page.html');
  assert.equal(result?.edits?.[0].text, ' type="button"');
  assert.equal(fixFixture(context, '<form>\n  <buttonish>Go</buttonish>\n</form>\n', 'page.html'), undefined);
  assert.equal(fixFixture(context, '<form>\n  <a>Go</a>\n</form>\n', 'page.html'), undefined);
});
