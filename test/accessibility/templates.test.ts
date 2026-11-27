// Markup templates (.html, .vue, .svelte, inline Angular) read into the accessibility element model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inlineAngularTemplates } from '../../lib/accessibility/angular-inline.js';
import { walkElements } from '../../lib/accessibility/markup.js';
import type { MarkupAttribute, MarkupDocument, MarkupElement } from '../../lib/accessibility/markup.js';
import { checkMarkup } from '../../lib/accessibility/rules.js';
import { templateDocument } from '../../lib/accessibility/template-elements.js';
import type { TemplateDialect } from '../../lib/accessibility/template-elements.js';
import { checkTemplateFile } from '../../lib/accessibility/template-file.js';
import { ts } from '../../lib/performance/compiler.js';

function parse(text: string, dialect: TemplateDialect = 'html'): MarkupDocument {
  return templateDocument('sample', text, dialect);
}

function elements(document: MarkupDocument): MarkupElement[] {
  return [...walkElements(document.roots)];
}

function only(text: string, dialect: TemplateDialect = 'html'): MarkupElement {
  const [first] = parse(text, dialect).roots;
  assert.ok(first, `no element parsed from ${text}`);
  return first;
}

function attributeSummary(attributes: readonly MarkupAttribute[]): string[] {
  return attributes.map((attribute) =>
    attribute.value.kind === 'static' ? `${attribute.name}=${attribute.value.text}` : `${attribute.name}=<dynamic>`,
  );
}

function tagNames(document: MarkupDocument): string[] {
  return elements(document).map((element) => element.tagName);
}

test('comments, doctype and CDATA hold no elements', () => {
  const document = parse('<!doctype html><!-- <img src=x> --><![CDATA[ <b> ]]><p>a</p>');
  assert.deepEqual(tagNames(document), ['p']);
});

test('script and style bodies are not parsed as markup', () => {
  const document = parse('<script>var s = "<img src=x>"; if (a < b) {}</script><style>a > b {}</style><p>x</p>');
  assert.deepEqual(tagNames(document), ['script', 'style', 'p']);
  assert.equal(elements(document)[0]?.children.length, 0);
});

test('a > inside a quoted attribute value does not end the tag', () => {
  const element = only('<a title="a > b" href=\'x>y\'>go</a>');
  assert.deepEqual(attributeSummary(element.attributes), ['title=a > b', 'href=x>y']);
});

test('unquoted and valueless attributes', () => {
  const element = only('<input type=text disabled value=a/b>');
  assert.deepEqual(attributeSummary(element.attributes), ['type=text', 'disabled=', 'value=a/b']);
});

test('void elements and self-closing tags take no children', () => {
  const document = parse('<div><img src="a"><br><input>text<Foo/><hr/></div>', 'vue');
  const [div] = document.roots;
  assert.deepEqual(
    div?.children.map((child) => child.tagName),
    ['img', 'br', 'input', 'Foo', 'hr'],
  );
});

test('unclosed elements close at the end and unmatched end tags are ignored', () => {
  const document = parse('</span><div><p>one<span>two</div></b><p>three');
  assert.deepEqual(tagNames(document), ['div', 'p', 'span', 'p']);
  assert.equal(document.roots.length, 2);
});

test('HTML tag names are case-insensitive', () => {
  const element = only('<IMG SRC="a.png" ALT="x">');
  assert.equal(element.tagName, 'img');
  assert.equal(element.isIntrinsic, true);
  assert.deepEqual(attributeSummary(element.attributes), ['src=a.png', 'alt=x']);
});

test('list items and table cells close implicitly in HTML', () => {
  const document = parse('<ul><li>a<li>b</ul><table><tr><td>1<td>2<tr><td>3</table>');
  const [list, table] = document.roots;
  assert.equal(list?.children.length, 2);
  assert.equal(table?.children.length, 2);
  assert.equal(table?.children[0]?.children.length, 2);
});

test('title and textarea bodies are raw text', () => {
  const document = parse('<title>a <b> c</title><textarea><i></textarea>');
  assert.deepEqual(tagNames(document), ['title', 'textarea']);
});

test('Vue attribute bindings are unwrapped', () => {
  const element = only(
    '<img :alt="a" v-bind:src="b" @click.prevent="f" v-on:keydown.enter="g" v-model="m" v-if="x" class="c" #default>',
    'vue',
  );
  assert.deepEqual(attributeSummary(element.attributes), [
    'alt=<dynamic>',
    'src=<dynamic>',
    'onclick=<dynamic>',
    'onkeydown=<dynamic>',
    'value=<dynamic>',
    'class=c',
  ]);
  assert.equal(element.hasSpreadAttributes, false);
});

test('Vue v-bind object and dynamic argument are spreads; interpolated values are dynamic', () => {
  assert.equal(only('<img v-bind="props">', 'vue').hasSpreadAttributes, true);
  assert.equal(only('<img :[name]="x">', 'vue').hasSpreadAttributes, true);
  assert.deepEqual(attributeSummary(only('<img alt="{{ x }}">', 'vue').attributes), ['alt=<dynamic>']);
});

test('Angular property bindings keep a non-ARIA aria-prefixed input name out of the aria- check', () => {
  const element = only('<a [ariaCurrentWhenActive]="mode" [ariaLabel]="label"></a>', 'angular');
  assert.deepEqual(attributeSummary(element.attributes), ['ariacurrentwhenactive=<dynamic>', 'aria-label=<dynamic>']);
});

test('an empty handler registers no click handler', () => {
  for (const [dialect, source] of [
    ['vue', '<div @click="() => {}">x</div>'],
    ['angular', '<div (click)="{}">x</div>'],
    ['svelte', '<div on:click={() => {}}>x</div>'],
  ] as const) {
    assert.deepEqual(attributeSummary(only(source, dialect).attributes), [], dialect);
  }
});

test('Angular bindings are unwrapped and structural directives ignored', () => {
  const element = only(
    '<img [alt]="a" [attr.aria-label]="b" (click)="f()" (keydown.enter)="g()" [(ngModel)]="m" *ngIf="x" #ref [class.on]="y" [ariaLabel]="z" alt2="{{ q }}">',
    'angular',
  );
  assert.deepEqual(attributeSummary(element.attributes), [
    'alt=<dynamic>',
    'aria-label=<dynamic>',
    'onclick=<dynamic>',
    'onkeydown=<dynamic>',
    'aria-label=<dynamic>',
    'alt2=<dynamic>',
  ]);
});

test('Svelte bindings, spreads and blocks', () => {
  const element = only(
    '<img alt={a} {src} {...props} on:click|preventDefault={f} bind:value class:on={x} use:tip bind:this={el} title="plain">',
    'svelte',
  );
  assert.deepEqual(attributeSummary(element.attributes), [
    'alt=<dynamic>',
    'src=<dynamic>',
    'onclick=<dynamic>',
    'value=<dynamic>',
    'title=plain',
  ]);
  assert.equal(element.hasSpreadAttributes, true);
  const block = only('<ul>{#each items as item}<li>{item}</li>{/each}</ul>', 'svelte');
  assert.equal(block.children.length, 1);
  assert.equal(only('<div>{#if a < b}<img src="x">{/if}</div>', 'svelte').children.length, 1);
  assert.equal(only('<img {...$$restProps}>', 'svelte').hasSpreadAttributes, true);
});

test('framework bindings inside a plain HTML file are understood', () => {
  const element = only('<img :alt="a" x-bind:src="b" [title]="c" @click="d">');
  assert.deepEqual(attributeSummary(element.attributes), [
    'alt=<dynamic>',
    'src=<dynamic>',
    'title=<dynamic>',
    'onclick=<dynamic>',
  ]);
});

test('components are not intrinsic', () => {
  assert.equal(only('<Button/>', 'vue').isIntrinsic, false);
  assert.equal(only('<button/>', 'vue').isIntrinsic, true);
  assert.equal(only('<app-root></app-root>', 'angular').isIntrinsic, false);
  assert.equal(only('<Foo.Bar/>', 'svelte').isIntrinsic, false);
  assert.equal(only('<svelte:head></svelte:head>', 'svelte').isIntrinsic, false);
});

test('template and ng-container wrappers are transparent', () => {
  const vue = only('<div><template v-if="a"><img src="x"><template #foo>hi</template></template></div>', 'vue');
  assert.deepEqual(
    vue.children.map((child) => child.tagName),
    ['img'],
  );
  const angular = only(
    '<ul><ng-container *ngIf="a"><li>x</li></ng-container><ng-template #t><li>y</li></ng-template></ul>',
    'angular',
  );
  assert.equal(angular.children.length, 2);
  const html = only('<template><p>x</p></template>');
  assert.equal(html.tagName, 'template');
});

test('server template constructs: attributes and text are treated as unknown, not as missing', () => {
  const dynamic = only('<img src="{{ url }}" alt="<%= alt %>" {% if a %}class="x"{% endif %}>');
  assert.deepEqual(attributeSummary(dynamic.attributes), ['src=<dynamic>', 'alt=<dynamic>', 'class=x']);
  assert.equal(dynamic.hasSpreadAttributes, true);
  assert.equal(only('<div>{% if a < b %}<img src="x">{% endif %}</div>').children.length, 1);
});

test('positions are 1-based lines and columns of the whole text', () => {
  const text = 'line one\n  <div\n    class="a">\n    <img src="x"></div>';
  const document = parse(text);
  const div = document.roots[0];
  const image = div?.children[0];
  assert.equal(div?.line, 2);
  assert.equal(div?.column, 3);
  assert.equal(div?.attributes[0]?.line, 3);
  assert.equal(div?.attributes[0]?.column, 5);
  assert.equal(image?.line, 4);
  assert.equal(image?.column, 5);
  assert.equal(document.text, text);
});

function missingAltFindings(file: string, text: string) {
  return checkTemplateFile(file, text).filter((finding) => finding.ruleId === 'a11y-img-missing-alt');
}

test('a vue template block keeps positions relative to the whole file', () => {
  const text = '<script>x</script>\n<template>\n  <img src="a">\n</template>';
  const findings = missingAltFindings('Sample.vue', text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 3);
  assert.equal(findings[0].column, 3);
});

test('vue template region handles nesting, other blocks and pug', () => {
  const nested = '<style>p {}</style>\n<template><template v-if="a"><img src="a"></template><p>y</p></template>';
  assert.deepEqual(
    missingAltFindings('Nested.vue', nested).map((finding) => finding.line),
    [2],
  );
  assert.deepEqual(missingAltFindings('Pug.vue', '<template lang="pug">\nimg(src="a")\n</template>'), []);
  const withI18n = '<i18n>{"a": "<template>"}</i18n>\n<template><img src="a"></template>';
  assert.equal(missingAltFindings('Blocks.vue', withI18n).length, 1);
  assert.deepEqual(missingAltFindings('NoTemplate.vue', '<script><img src="a"></script>'), []);
});

test('inline Angular templates point into the .ts file', () => {
  const source = [
    "import { Component } from '@angular/core';",
    '@Component({',
    "  selector: 'app-x',",
    '  template: `',
    '    <img src="a.png">',
    '  `,',
    '})',
    'export class X {}',
    "@Component({ template: '<button>{{ a }}</button>' })",
    'export class Y {}',
    '@Component({ template: `<p>${dynamic}</p>` })',
    'export class Z {}',
    '@Other({ template: "<b></b>" })',
    'export class W {}',
  ].join('\n');
  const sourceFile = ts.createSourceFile('x.component.ts', source, ts.ScriptTarget.Latest, true);
  const documents = inlineAngularTemplates(sourceFile, 'x.component.ts');
  assert.equal(documents.length, 2);
  const image = documents[0]?.roots[0];
  assert.equal(image?.tagName, 'img');
  assert.equal(image?.line, 5);
  assert.equal(image?.column, 5);
  assert.equal(documents[0]?.text, source);
  const button = documents[1]?.roots[0];
  assert.equal(button?.line, 9);
});

test('checkTemplateFile reads markup files and skips others', () => {
  const rulesAreLive = checkMarkup(templateDocument('probe.html', '<img src="a.png">', 'html')).length > 0;
  const findings = checkTemplateFile('page.html', '<html>\n<body>\n<img src="a.png">\n</body></html>');
  assert.ok(Array.isArray(findings));
  if (rulesAreLive) {
    const missing = findings.find((finding) => finding.ruleId === 'a11y-img-missing-alt');
    assert.equal(missing?.line, 3);
  }
  assert.deepEqual(checkTemplateFile('notes.txt', '<img src="a.png">'), []);
  assert.deepEqual(checkTemplateFile('vendor/page.html', '<img src="a.png">'), []);
  assert.deepEqual(checkTemplateFile('page.min.html', '<img src="a.png">'), []);
  assert.deepEqual(checkTemplateFile('page.html', '<!-- Generated by tool. Do not edit. -->\n<img src="a.png">'), []);
  assert.deepEqual(checkTemplateFile('Page.vue', '<template lang="pug">\nimg(src="a")\n</template>'), []);
});

test('an html file named by a sibling templateUrl is read as Angular', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-a11y-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'card.ts'), "@Component({ templateUrl: './card.html' }) class Card {}");
  const htmlPath = path.join(directory, 'card.html');
  fs.writeFileSync(htmlPath, '<img [alt]="label" src="a.png">');
  const findings = checkTemplateFile(htmlPath, '<img [alt]="label" src="a.png">');
  assert.equal(findings.filter((finding) => finding.ruleId === 'a11y-img-missing-alt').length, 0);
});

test('click bindings that only stop propagation are not activation handlers', () => {
  const clickableRuleIds = (dialect: TemplateDialect, markup: string): string[] =>
    checkMarkup(templateDocument(`panel.${dialect}`, markup, dialect)).map((finding) => finding.ruleId);
  const silent: [TemplateDialect, string][] = [
    ['vue', '<div @click.stop>x</div>'],
    ['vue', '<div @click="$event.stopPropagation()">x</div>'],
    ['angular', '<div (click)="$event.stopPropagation()">x</div>'],
    ['svelte', '<div on:click={(event) => event.stopPropagation()}>x</div>'],
  ];
  for (const [dialect, markup] of silent) assert.deepEqual(clickableRuleIds(dialect, markup), [], markup);
  const flagged: [TemplateDialect, string][] = [
    ['vue', '<div @click="open">x</div>'],
    ['angular', '<div (click)="open()">x</div>'],
    ['svelte', '<div on:click={open}>x</div>'],
    ['svelte', '<div on:click>x</div>'],
  ];
  for (const [dialect, markup] of flagged) {
    assert.deepEqual(clickableRuleIds(dialect, markup), ['a11y-clickable-non-interactive'], markup);
  }
});
