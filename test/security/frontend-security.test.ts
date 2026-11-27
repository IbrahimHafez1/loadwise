import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { withProgram } from '../performance/helpers.js';
import { createAnalyzer } from '../../lib/security/analyze.js';
import * as frontend from '../../lib/security/exposure/frontend-security.js';
import type { ProgramAdapter } from '../../lib/shared/types.js';
import type { LocatedFinding } from '../types/security.js';

const probe = {
  checks: {
    BinaryExpression: [frontend.checkAssignment],
    CallExpression: [frontend.checkCall],
    JsxAttribute: [frontend.checkJsxAttribute],
    PropertyAssignment: [frontend.checkProperty],
  },
};
const analyzeFile = createAnalyzer([probe]);
const compilerOptions = { lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], jsx: ts.JsxEmit.Preserve };

const stubs = {
  dompurify: {
    'node_modules/dompurify/index.d.ts':
      'declare const DOMPurify: { sanitize(html: string): string }; export default DOMPurify;',
  },
  escapeHtml: {
    'node_modules/escape-html/index.d.ts':
      'declare function escapeHtml(text: string): string; export default escapeHtml;',
  },
  i18next: {
    'node_modules/react-i18next/index.d.ts': 'export declare function useTranslation(): { t(key: string): string };',
  },
  react: {
    'node_modules/@types/react/index.d.ts':
      'declare global { namespace JSX { interface IntrinsicElements { [name: string]: any } } }\nexport {};',
  },
  angular: {
    'node_modules/@angular/platform-browser/index.d.ts': [
      'export declare class DomSanitizer {',
      '  bypassSecurityTrustHtml(value: string): unknown;',
      '  bypassSecurityTrustResourceUrl(value: string): unknown;',
      '  sanitize(context: number, value: string | null): string | null;',
      '}',
    ].join('\n'),
  },
  vue: {
    'node_modules/vue/index.d.ts':
      'export declare function h(tag: string, props?: object): unknown;\ndeclare const Vue: { extend(options: object): unknown }; export default Vue;',
  },
};

// Findings of one rule for `source`, saved as `fileName` (a .tsx file for JSX).
function findingsOf(ruleId: string, source: string, files: Record<string, string> = {}, fileName = 'main.ts') {
  return withProgram(
    fileName === 'main.ts' ? source : '',
    { ...(fileName === 'main.ts' ? {} : { [fileName]: source }), ...files },
    (program: ProgramAdapter) => {
      assert.ok(program.getSourceFiles);
      const sourceFile = program
        .getSourceFiles()
        .find((file) => file.fileName.replaceAll('\\', '/').endsWith(`/${fileName}`));
      assert.ok(sourceFile);
      return analyzeFile(program, sourceFile).filter((finding) => finding.ruleId === ruleId);
    },
    compilerOptions,
  );
}

const defaultFindingsOf = (...args: Parameters<typeof findingsOf>) =>
  findingsOf(...args).filter((finding: LocatedFinding) => !finding.contextualReason);

test('dom-xss-sink: URL, referrer, form and postMessage values written as HTML are reported by default', () => {
  const sources = [
    'declare const el: HTMLElement;\nel.innerHTML = location.hash;',
    "declare const el: HTMLElement;\nel.innerHTML = '<p>' + decodeURIComponent(window.location.search.slice(1)) + '</p>';",
    "declare const el: HTMLElement;\nconst params = new URLSearchParams(location.search);\nel.innerHTML = `<h1>${params.get('q')}</h1>`;",
    'declare const el: HTMLElement;\nel.insertAdjacentHTML("beforeend", document.referrer);',
    'document.write(document.cookie);',
    'declare const input: HTMLInputElement;\nconst box = document.body;\nbox.outerHTML = input.value;',
    'declare const el: HTMLElement;\nwindow.addEventListener("message", (event) => { if (event.origin === "https://a.example") el.innerHTML = event.data; });',
    'declare const range: Range;\nrange.createContextualFragment(location.hash);',
  ];
  for (const source of sources) assert.equal(defaultFindingsOf('dom-xss-sink', source).length, 1, source);
});

test('dom-xss-sink: the message names the untrusted source', () => {
  const [finding] = findingsOf('dom-xss-sink', 'declare const el: HTMLElement;\nel.innerHTML = location.hash;');
  assert.match(finding.message, /^`location\.hash` reaches `innerHTML` unsanitized/);
});

test('dom-xss-sink: fetched and unknown dynamic values are contextual', () => {
  const sources = [
    'declare const el: HTMLElement;\nexport function render(html: string) { el.innerHTML = html; }',
    'declare const el: HTMLElement;\nexport async function load(url: string) { const response = await fetch(url); el.innerHTML = await response.text(); }',
    'declare const el: HTMLElement;\nexport async function load(url: string) { const data = await (await fetch(url)).json(); el.innerHTML = data.html; }',
    'declare const el: HTMLElement;\nfunction sanitize(value: string) { return value; }\nel.innerHTML = sanitize(location.hash);',
  ];
  for (const source of sources) {
    const found = findingsOf('dom-xss-sink', source);
    assert.equal(found.length, 1, source);
    assert.ok(found[0].contextualReason, source);
  }
});

test('dom-xss-sink: constants, numbers, escaped and sanitized values are clean', () => {
  const header =
    "import DOMPurify from 'dompurify';\nimport escapeHtml from 'escape-html';\nimport { useTranslation } from 'react-i18next';\n";
  const bodies = [
    "el.innerHTML = '<b>static</b>';",
    'el.innerHTML = `<li>${items.length}</li>`;',
    'el.innerHTML = String(items.length) + count;',
    'el.innerHTML = DOMPurify.sanitize(location.hash);',
    'const clean = DOMPurify.sanitize(location.hash); el.innerHTML = `<p>${clean}</p>`;',
    'el.innerHTML = escapeHtml(location.hash);',
    "el.innerHTML = location.hash.replace(/</g, '&lt;');",
    "const { t } = useTranslation(); el.innerHTML = t('greeting');",
    "const mode: 'a' | 'b' = pick(); el.innerHTML = mode;",
    "el.insertAdjacentHTML('beforeend', DOMPurify.sanitize(location.hash));",
    "el.innerHTML = '';",
  ];
  const files = { ...stubs.dompurify, ...stubs.escapeHtml, ...stubs.i18next };
  for (const body of bodies) {
    const source = `${header}declare const el: HTMLElement; declare const items: string[]; declare const count: number; declare function pick(): 'a' | 'b';\n${body}`;
    assert.equal(findingsOf('dom-xss-sink', source, files).length, 0, body);
  }
});

test('dom-xss-sink: only DOM receivers and the document are sinks', () => {
  const sources = [
    'const model = { innerHTML: "" };\nmodel.innerHTML = location.hash;',
    'declare const stream: WritableStreamDefaultWriter<string>;\nstream.write(location.hash);',
    'declare const anything: any;\nanything.innerHTML = location.hash;',
    'class Box { innerHTML = ""; insertAdjacentHTML(position: string, html: string) {} }\nnew Box().insertAdjacentHTML("x", location.hash);',
  ];
  for (const source of sources) assert.equal(findingsOf('dom-xss-sink', source).length, 0, source);
});

test('react-dangerously-set-inner-html: reports untrusted HTML, contextual for props', () => {
  const header = "import * as React from 'react';\n";
  const positive = `${header}export const View = () => <div dangerouslySetInnerHTML={{ __html: location.hash }} />;`;
  assert.equal(defaultFindingsOf('react-dangerously-set-inner-html', positive, stubs.react, 'view.tsx').length, 1);
  const shorthand = `${header}const __html = location.search;\nexport const View = () => <div dangerouslySetInnerHTML={{ __html }} />;`;
  assert.equal(defaultFindingsOf('react-dangerously-set-inner-html', shorthand, stubs.react, 'view.tsx').length, 1);
  const fromProps = `${header}export const View = (props: { html: string }) => <div dangerouslySetInnerHTML={{ __html: props.html }} />;`;
  const found = findingsOf('react-dangerously-set-inner-html', fromProps, stubs.react, 'view.tsx');
  assert.equal(found.length, 1);
  assert.ok(found[0].contextualReason);
});

test('react-dangerously-set-inner-html: sanitized, static, JSON-LD and non-React JSX are clean', () => {
  const header =
    "import * as React from 'react';\nimport DOMPurify from 'dompurify';\ndeclare const props: { html: string; data: object };\n";
  const files = { ...stubs.react, ...stubs.dompurify };
  const views = [
    '<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(props.html) }} />',
    "<div dangerouslySetInnerHTML={{ __html: '<b>x</b>' }} />",
    '<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(props.data) }} />',
  ];
  for (const view of views)
    assert.equal(
      findingsOf('react-dangerously-set-inner-html', `${header}export const V = () => ${view};`, files, 'view.tsx')
        .length,
      0,
      view,
    );
  const notReact =
    'declare const props: { html: string };\nexport const V = () => <div dangerouslySetInnerHTML={{ __html: props.html }} />;';
  assert.equal(findingsOf('react-dangerously-set-inner-html', notReact, {}, 'view.tsx').length, 0);
});

const angularClass = (body: string) =>
  `import { DomSanitizer } from '@angular/platform-browser';\nimport DOMPurify from 'dompurify';\nexport class Preview {\n  constructor(private sanitizer: DomSanitizer) {}\n  show(html: string) { ${body} }\n}`;

test('angular-bypass-security-trust: DomSanitizer bypass of dynamic values', () => {
  const files = { ...stubs.angular, ...stubs.dompurify };
  const untrusted = findingsOf(
    'angular-bypass-security-trust',
    angularClass('return this.sanitizer.bypassSecurityTrustHtml(location.hash);'),
    files,
  );
  assert.equal(untrusted.length, 1);
  assert.equal(untrusted[0].contextualReason, undefined);
  const dynamic = findingsOf(
    'angular-bypass-security-trust',
    angularClass('return this.sanitizer.bypassSecurityTrustHtml(html);'),
    files,
  );
  assert.equal(dynamic.length, 1);
  assert.ok(dynamic[0].contextualReason);
  const withoutTypes = findingsOf(
    'angular-bypass-security-trust',
    angularClass('return this.sanitizer.bypassSecurityTrustResourceUrl(html);'),
  );
  assert.equal(withoutTypes.length, 1);
});

test('angular-bypass-security-trust: literals, sanitized values and other classes are clean', () => {
  const files = { ...stubs.angular, ...stubs.dompurify };
  const clean = [
    "return this.sanitizer.bypassSecurityTrustHtml('<b>x</b>');",
    'return this.sanitizer.bypassSecurityTrustHtml(DOMPurify.sanitize(html));',
  ];
  for (const body of clean)
    assert.equal(findingsOf('angular-bypass-security-trust', angularClass(body), files).length, 0, body);
  const other =
    'class Trust { bypassSecurityTrustHtml(value: string) { return value; } }\nexport const trusted = new Trust().bypassSecurityTrustHtml(location.hash);';
  assert.equal(findingsOf('angular-bypass-security-trust', other).length, 0);
});

test('vue-v-html-unsanitized: innerHTML in a render function from vue', () => {
  const rendered = "import { h } from 'vue';\nexport const view = () => h('div', { innerHTML: location.hash });";
  assert.equal(defaultFindingsOf('vue-v-html-unsanitized', rendered, stubs.vue).length, 1);
  const vueTwo =
    "import Vue from 'vue';\nexport default Vue.extend({ render(h: any) { return h('div', { domProps: { innerHTML: (this as any).html } }); } });";
  const found = findingsOf('vue-v-html-unsanitized', vueTwo, stubs.vue);
  assert.equal(found.length, 1);
  assert.ok(found[0].contextualReason);
});

test('vue-v-html-unsanitized: other h functions, static and sanitized values are clean', () => {
  const clean = [
    "declare function h(tag: string, props: object): unknown;\nh('div', { innerHTML: location.hash });",
    "import { h } from 'vue';\nh('div', { innerHTML: '<b>x</b>' });",
    "import { h } from 'vue';\nimport DOMPurify from 'dompurify';\nh('div', { innerHTML: DOMPurify.sanitize(location.hash) });",
    'export const options = { domProps: { innerHTML: location.hash } };',
  ];
  for (const source of clean)
    assert.equal(findingsOf('vue-v-html-unsanitized', source, { ...stubs.vue, ...stubs.dompurify }).length, 0, source);
});

test('frontend-storage-secret-token: credentials stored under a sensitive key in web storage', () => {
  const sources = [
    "declare const value: string;\nlocalStorage.setItem('token', value);",
    "declare const value: string;\nlocalStorage.setItem('authToken', value);",
    "declare const value: string;\nsessionStorage.setItem('jwt', value);",
    "declare const value: string;\nwindow.localStorage.setItem('refresh_token', value);",
    "declare const value: string;\nconst KEY = 'accessToken';\nlocalStorage.setItem(KEY, value);",
    'declare const value: string; declare const user: string;\nlocalStorage.setItem(`apiKey:${user}`, value);',
  ];
  for (const source of sources) assert.equal(findingsOf('frontend-storage-secret-token', source).length, 1, source);
});

test('frontend-storage-secret-token: matches the key, not the value, and only on Storage', () => {
  const clean = [
    "localStorage.setItem('theme', 'token-dark');",
    "declare const user: { token: string };\nlocalStorage.setItem('profile', JSON.stringify(user));",
    "declare const value: string;\nlocalStorage.setItem('csrfToken', value);",
    "declare const value: string;\nlocalStorage.setItem('page_token', value);",
    "declare const cache: Map<string, string> & { setItem(key: string, value: string): void };\ncache.setItem('token', 'x');",
    "declare const anything: any;\nanything.setItem('token', 'x');",
    'declare const key: string;\nlocalStorage.setItem(key, "x");',
  ];
  for (const source of clean) assert.equal(findingsOf('frontend-storage-secret-token', source).length, 0, source);
});

test('postmessage-missing-origin-check: wildcard target origin', () => {
  const sensitive = "declare const secret: string;\nwindow.parent.postMessage({ token: secret }, '*');";
  assert.equal(defaultFindingsOf('postmessage-missing-origin-check', sensitive).length, 1);
  const plain = findingsOf('postmessage-missing-origin-check', "window.parent.postMessage('ready', '*');");
  assert.equal(plain.length, 1);
  assert.match(plain[0].contextualReason ?? '', /public data/);
  const options = findingsOf('postmessage-missing-origin-check', "window.postMessage('x', { targetOrigin: '*' });");
  assert.equal(options.length, 1);
});

test('postmessage-missing-origin-check: a named origin, workers and ports are clean', () => {
  const clean = [
    "window.parent.postMessage('ready', 'https://app.example');",
    "window.parent.postMessage('ready', location.origin);",
    "const worker = new Worker('w.js');\nworker.postMessage({ token: 'x' });",
    "const channel = new MessageChannel();\nchannel.port1.postMessage({ token: 'x' });",
  ];
  for (const source of clean) assert.equal(findingsOf('postmessage-missing-origin-check', source).length, 0, source);
});

test('postmessage-missing-origin-check: a message listener that reads data without checking the sender', () => {
  const sources = [
    "window.addEventListener('message', (event) => { console.log(event.data); });",
    "function onMessage(event: MessageEvent) { console.log(event.data.type); }\nwindow.addEventListener('message', onMessage);",
    "const onMessage = ({ data }: MessageEvent) => { console.log(data); };\nwindow.addEventListener('message', onMessage);",
    "window.addEventListener('message', (event) => { const { data } = event; console.log(data); });",
  ];
  for (const source of sources)
    assert.equal(defaultFindingsOf('postmessage-missing-origin-check', source).length, 1, source);
});

test('postmessage-missing-origin-check: listeners that check origin or source, or are not window listeners, are clean', () => {
  const clean = [
    "window.addEventListener('message', (event) => { if (event.origin !== 'https://a.example') return; console.log(event.data); });",
    "declare const frame: Window;\nwindow.addEventListener('message', (event) => { if (event.source !== frame) return; console.log(event.data); });",
    "window.addEventListener('message', ({ data, origin }) => { console.log(origin, data); });",
    "declare function isTrusted(event: MessageEvent): boolean;\nwindow.addEventListener('message', (event) => { if (isTrusted(event)) console.log(event.data); });",
    "window.addEventListener('message', (event) => { console.log(event.ports); });",
    "const channel = new MessageChannel();\nchannel.port1.addEventListener('message', (event) => { console.log(event.data); });",
    "const worker = new Worker('w.js');\nworker.addEventListener('message', (event) => { console.log(event.data); });",
    "window.addEventListener('click', (event) => { console.log(event.detail); });",
    "self.addEventListener('message', (event) => { console.log(event.data); });",
    "addEventListener('message', (event) => { console.log(event.data); });",
  ];
  for (const source of clean) assert.equal(findingsOf('postmessage-missing-origin-check', source).length, 0, source);
});
