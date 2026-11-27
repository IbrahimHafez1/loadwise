import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { jsxDocument } from '../../lib/accessibility/jsx-elements.js';
import type { MarkupElement } from '../../lib/accessibility/markup.js';

function roots(source: string): readonly MarkupElement[] {
  const sourceFile = ts.createSourceFile('src/App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return jsxDocument(sourceFile, 'src/App.tsx').roots;
}

function firstRoot(source: string): MarkupElement {
  const [root] = roots(source);
  assert.ok(root, 'expected a root element');
  return root;
}

test('translates props to lower-case HTML names', () => {
  const root = firstRoot('const a = <label htmlFor="x" className="c" tabIndex={1} onClick={go} aria-label="L" />;');
  assert.deepEqual(
    root.attributes.map(({ name }) => name),
    ['for', 'class', 'tabindex', 'onclick', 'aria-label'],
  );
});

test('reads literals as static values and everything else as dynamic', () => {
  const root = firstRoot('const a = <input a="x" b={"y"} c={1} d={`z`} e={-2} f={value} g={`a${b}`} h />;');
  const values = Object.fromEntries(root.attributes.map(({ name, value }) => [name, value]));
  assert.deepEqual(values.a, { kind: 'static', text: 'x' });
  assert.deepEqual(values.b, { kind: 'static', text: 'y' });
  assert.deepEqual(values.c, { kind: 'static', text: '1' });
  assert.deepEqual(values.d, { kind: 'static', text: 'z' });
  assert.deepEqual(values.e, { kind: 'static', text: '-2' });
  assert.deepEqual(values.f, { kind: 'dynamic' });
  assert.deepEqual(values.g, { kind: 'dynamic' });
  assert.deepEqual(values.h, { kind: 'static', text: '' });
});

test('flags spread attributes without listing them', () => {
  const root = firstRoot('const a = <img {...props} alt="x" />;');
  assert.equal(root.hasSpreadAttributes, true);
  assert.deepEqual(
    root.attributes.map(({ name }) => name),
    ['alt'],
  );
});

test('separates intrinsic elements from components and custom elements', () => {
  const tags = roots('const a = <div><Image /><Foo.Bar /><my-widget /><svg:rect /></div>;')[0].children;
  assert.deepEqual(
    tags.map(({ tagName, isIntrinsic }) => [tagName, isIntrinsic]),
    [
      ['Image', false],
      ['Foo.Bar', false],
      ['my-widget', false],
      ['svg:rect', false],
    ],
  );
  assert.equal(firstRoot('const a = <div />;').isIntrinsic, true);
});

test('nests children, fragments and JSX inside expressions', () => {
  const root = firstRoot('const a = <ul>{ok && <li />}{items.map((item) => <li key={item} />)}<><li /></></ul>;');
  assert.deepEqual(
    root.children.map(({ tagName }) => tagName),
    ['li', 'li', 'li'],
  );
});

test('makes the outermost elements the roots, including JSX in returns and fragments', () => {
  const found = roots('function A() { return <><p /><p /></>; }\nconst b = <section />;');
  assert.deepEqual(
    found.map(({ tagName }) => tagName),
    ['p', 'p', 'section'],
  );
});

test('puts JSX passed as a prop among the children of the element', () => {
  const [wrapper, icon] = roots('const a = <Wrapper icon={<img />} />;');
  assert.equal(wrapper.children.length, 1);
  assert.equal(wrapper.children[0].tagName, 'img');
  assert.equal(icon, undefined);
});

test('reports 1-based positions', () => {
  const source = 'const a = (\n  <button type="button" />\n);';
  const root = firstRoot(source);
  assert.deepEqual([root.line, root.column], [2, 3]);
  assert.deepEqual([root.attributes[0].line, root.attributes[0].column], [2, 11]);
});
