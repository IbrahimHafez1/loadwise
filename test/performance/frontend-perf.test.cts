import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { createRuleContext, withProgram, requireContextualReason } from './helpers.cjs';
import { checkFrontendFile } from '../../lib/performance/frontend-perf.cjs';
import siteFixes from '../../lib/performance/site-fixes/frontend-fixes.cjs';
import type { Node } from 'typescript';
import type { Finding, FixResult, ProgramAdapter, SiteFixInput, TextEdit } from '../../lib/shared/types.cjs';
import type { NodeFinding } from '../types/node-finding.cjs';

const packages = {
  'node_modules/react/index.d.ts': `
    export declare function useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
    export declare function useLayoutEffect(effect: () => void | (() => void), deps?: unknown[]): void;
    export declare function memo<T>(component: T): T;
  `,
  'node_modules/rxjs/index.d.ts': `
    export declare class Observable<T> {
      subscribe(next: (value: T) => void): { unsubscribe(): void };
      pipe(...operators: unknown[]): Observable<T>;
    }
    export declare class Subject<T> extends Observable<T> { next(value: T): void }
    export declare function interval(period: number): Observable<number>;
    export declare function of<T>(value: T): Observable<T>;
    export declare function first(): unknown;
  `,
  'node_modules/@angular/core/index.d.ts': 'export declare function Component(metadata: object): ClassDecorator;',
  'node_modules/@angular/common/index.d.ts': `
    import { Observable } from 'rxjs';
    export declare class HttpClient { get<T>(url: string): Observable<T> }
  `,
  'node_modules/vue/index.d.ts': `
    export declare function onMounted(callback: () => void): void;
    export declare function onUnmounted(callback: () => void): void;
    export declare function h(tag: string, props?: unknown, children?: unknown): unknown;
  `,
  'node_modules/lodash/index.d.ts':
    'declare const _: { debounce: Function }; export default _; export declare function debounce(): void;',
  'node_modules/lodash/debounce.d.ts': 'declare const debounce: unknown; export default debounce;',
  'node_modules/moment/index.d.ts': 'declare function moment(): unknown; export default moment;',
  'node_modules/date-fns/index.d.ts': 'export declare const format: unknown;',
};

// The program reads lib.dom so DOM declarations resolve; the file under test keeps its own
// extension.
function findings(
  source: string,
  fileName = 'view.tsx',
  extraFiles: Readonly<Record<string, string>> = {},
): NodeFinding[] {
  const options = { lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], jsx: ts.JsxEmit.Preserve, experimentalDecorators: true };
  return withProgram(
    'export {};',
    { ...packages, [fileName]: source, ...extraFiles },
    (program: ProgramAdapter) => {
      assert.ok(program.getSourceFiles);
      const sourceFile = program.getSourceFiles().find((file) => file.fileName.endsWith(fileName));
      assert.ok(sourceFile);
      const found: NodeFinding[] = [];
      const context = createRuleContext(program, {
        report(node: Node, ruleId: string, message: string, contextualReason?: string) {
          found.push({ ruleId, message, contextualReason, node });
        },
      });
      checkFrontendFile(sourceFile, context);
      return found;
    },
    options,
  );
}

function only(
  source: string,
  ruleId: string,
  fileName?: string,
  extraFiles?: Readonly<Record<string, string>>,
): NodeFinding[] {
  return findings(source, fileName, extraFiles).filter((finding: Finding) => finding.ruleId === ruleId);
}

function siteFixInput(finding: NodeFinding): SiteFixInput {
  return { finding, node: leftmostNode(finding.node), load: () => null };
}

function editsOf(fix: FixResult | undefined): TextEdit[] {
  assert.ok(fix?.edits);
  return fix.edits;
}

function leftmostNode(node: Node): Node {
  let current = node;
  while (current.getChildren().length > 0) current = current.getChildren()[0];
  return current;
}

const REACT_IMPORT = "import { useEffect, memo } from 'react';\n";

test('react-missing-cleanup reports a window listener in an effect without cleanup', () => {
  const found = only(
    `${REACT_IMPORT}export function A() { useEffect(() => { window.addEventListener('keydown', () => {}); }, []); return null; }`,
    'react-missing-cleanup',
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].contextualReason, undefined);
});

test('react-missing-cleanup reports setInterval and stays quiet for a one-shot setTimeout', () => {
  const interval = `${REACT_IMPORT}export function A() { useEffect(() => { setInterval(() => {}, 1000); }, []); return null; }`;
  const timeout = `${REACT_IMPORT}export function A() { useEffect(() => { setTimeout(() => {}, 1000); }, []); return null; }`;
  assert.equal(only(interval, 'react-missing-cleanup').length, 1);
  assert.deepEqual(only(timeout, 'react-missing-cleanup'), []);
});

test('react-missing-cleanup accepts a returned cleanup and element-owned listeners', () => {
  const cleaned = `${REACT_IMPORT}export function A() { useEffect(() => { const id = setInterval(() => {}, 1); return () => clearInterval(id); }, []); return null; }`;
  const element = `${REACT_IMPORT}export function A(p: { el: HTMLElement }) { useEffect(() => { p.el.addEventListener('click', () => {}); }, []); return null; }`;
  assert.deepEqual(only(cleaned, 'react-missing-cleanup'), []);
  assert.deepEqual(only(element, 'react-missing-cleanup'), []);
});

test('react-missing-cleanup requires useEffect to come from react', () => {
  const local =
    'function useEffect(callback: () => void) { callback(); }\nuseEffect(() => { setInterval(() => {}, 1); });';
  assert.deepEqual(only(local, 'react-missing-cleanup'), []);
});

test('react-missing-cleanup reports observers as contextual and rxjs subscriptions by source', () => {
  const observer = `${REACT_IMPORT}export function A() { useEffect(() => { new ResizeObserver(() => {}); }, []); return null; }`;
  const [observerFinding] = only(observer, 'react-missing-cleanup');
  assert.ok(observerFinding.contextualReason);
  assert.match(requireContextualReason(observerFinding), /element/);
  const endless = `${REACT_IMPORT}import { interval } from 'rxjs';\nexport function A() { useEffect(() => { interval(5).subscribe(() => {}); }, []); return null; }`;
  assert.equal(only(endless, 'react-missing-cleanup')[0].contextualReason, undefined);
  const finite = `${REACT_IMPORT}import { of, first } from 'rxjs';\nexport function A() { useEffect(() => { of(1).pipe(first()).subscribe(() => {}); }, []); return null; }`;
  assert.deepEqual(only(finite, 'react-missing-cleanup'), []);
});

test('react-fetch-in-effect-no-abort is firm with dependencies and contextual with an empty array', () => {
  const withDeps = `${REACT_IMPORT}export function A(p: { id: string }) { useEffect(() => { fetch('/x/' + p.id); }, [p.id]); return null; }`;
  const once = `${REACT_IMPORT}export function A() { useEffect(() => { const load = async () => { await fetch('/x'); }; load(); }, []); return null; }`;
  assert.equal(only(withDeps, 'react-fetch-in-effect-no-abort')[0].contextualReason, undefined);
  const { contextualReason } = only(once, 'react-fetch-in-effect-no-abort')[0];
  assert.ok(contextualReason);
  assert.match(contextualReason, /once per mount/);
});

test('react-fetch-in-effect-no-abort accepts an AbortController, a signal option, or a cleanup', () => {
  const abort = `${REACT_IMPORT}export function A() { useEffect(() => { const c = new AbortController(); fetch('/x', { signal: c.signal }); return () => c.abort(); }, []); return null; }`;
  const signalOnly = `${REACT_IMPORT}export function A(s: AbortSignal) { useEffect(() => { fetch('/x', { signal: s }); }, []); return null; }`;
  const ignoreFlag = `${REACT_IMPORT}export function A() { useEffect(() => { let live = true; fetch('/x'); return () => { live = false; }; }, []); return null; }`;
  const notBrowserFetch = `${REACT_IMPORT}const api = { fetch(url: string) {} };\nexport function A() { useEffect(() => { api.fetch('/x'); }, []); return null; }`;
  for (const source of [abort, signalOnly, ignoreFlag, notBrowserFetch]) {
    assert.deepEqual(only(source, 'react-fetch-in-effect-no-abort'), []);
  }
});

test('react-index-as-key reports the index key on the rendered item as contextual', () => {
  const found = only(
    'export function A(p: { rows: string[] }) { return <ul>{p.rows.map((row, index) => <li key={index}>{row}</li>)}</ul>; }',
    'react-index-as-key',
  );
  assert.equal(found.length, 1);
  assert.ok(found[0].contextualReason);
  assert.match(requireContextualReason(found[0]), /never reorder/);
});

test('react-index-as-key ignores stable keys, static lists, and non-array map', () => {
  const stable =
    'export function A(p: { rows: { id: string }[] }) { return <ul>{p.rows.map((row, index) => <li key={row.id}>{index}</li>)}</ul>; }';
  const literal =
    "export function A() { return <ul>{['a', 'b'].map((row, index) => <li key={index}>{row}</li>)}</ul>; }";
  const constant =
    "const TABS = ['a', 'b'];\nexport function A() { return <ul>{TABS.map((row, index) => <li key={index}>{row}</li>)}</ul>; }";
  const notArray =
    "const stream = { map(callback: (value: string, index: number) => unknown) { return callback('a', 0); } };\nexport const A = stream.map((row, index) => <li key={index}>{row}</li>);";
  const nested =
    'export function A(p: { rows: { id: string }[] }) { return <ul>{p.rows.map((row, index) => <li key={row.id}><span key={index}>x</span></li>)}</ul>; }';
  for (const source of [stable, literal, constant, notArray, nested]) {
    assert.deepEqual(only(source, 'react-index-as-key'), []);
  }
});

test('react-inline-object-in-jsx-prop reports only for memoised components, as contextual', () => {
  const memoised = `${REACT_IMPORT}const Row = memo((p: { options: object }) => null);\nexport const A = () => <Row options={{ a: 1 }} />;`;
  const plain = 'const Row = (p: { options: object }) => null;\nexport const A = () => <Row options={{ a: 1 }} />;';
  const found = only(memoised, 'react-inline-object-in-jsx-prop');
  assert.equal(found.length, 1);
  assert.ok(found[0].contextualReason);
  assert.deepEqual(only(plain, 'react-inline-object-in-jsx-prop'), []);
});

const ANGULAR_HEAD =
  "import { Component } from '@angular/core';\nimport { Subject, interval, first } from 'rxjs';\nimport { HttpClient } from '@angular/common';\n";

function angular(source: string, ruleId = 'angular-subscribe-without-cleanup') {
  return only(source, ruleId, 'a.component.ts');
}

test('angular-subscribe-without-cleanup is firm for endless sources', () => {
  const source = `${ANGULAR_HEAD}@Component({})\nexport class A { events = new Subject<number>(); constructor() { this.events.subscribe(() => {}); interval(5).subscribe(() => {}); } }`;
  const found = angular(source);
  assert.equal(found.length, 2);
  assert.ok(found.every((finding: Finding) => finding.contextualReason === undefined));
});

test('angular-subscribe-without-cleanup stays quiet for HttpClient, completing operators, and ngOnDestroy', () => {
  const http = `${ANGULAR_HEAD}@Component({})\nexport class A { constructor(private http: HttpClient) { this.http.get('/x').subscribe(() => {}); } }`;
  const operator = `${ANGULAR_HEAD}@Component({})\nexport class A { constructor() { interval(5).pipe(first()).subscribe(() => {}); } }`;
  const destroyed = `${ANGULAR_HEAD}@Component({})\nexport class A { s = interval(5).subscribe(() => {}); ngOnDestroy() { this.s.unsubscribe(); } }`;
  for (const source of [http, operator, destroyed]) assert.deepEqual(angular(source), []);
});

test('angular-subscribe-without-cleanup is contextual for unknown sources and ignores non-components', () => {
  const unknown = `${ANGULAR_HEAD}declare const route: { params: import('rxjs').Observable<string> };\n@Component({})\nexport class A { constructor() { route.params.subscribe(() => {}); } }`;
  const service = `${ANGULAR_HEAD}export class Plain { constructor() { interval(5).subscribe(() => {}); } }`;
  const { contextualReason } = angular(unknown)[0];
  assert.ok(contextualReason);
  assert.match(contextualReason, /complete/);
  assert.deepEqual(angular(service), []);
});

test('angular-default-change-detection is contextual and skips components that set a strategy', () => {
  const missing = `${ANGULAR_HEAD}@Component({ selector: 'x' })\nexport class A {}`;
  const set = `${ANGULAR_HEAD}@Component({ selector: 'x', changeDetection: 1 })\nexport class A {}`;
  const foreign = 'declare function Component(metadata: object): ClassDecorator;\n@Component({})\nexport class A {}';
  const zoneless = `${ANGULAR_HEAD}const provider = 'provideZonelessChangeDetection';\n@Component({})\nexport class A {}`;
  const found = angular(missing, 'angular-default-change-detection');
  assert.equal(found.length, 1);
  assert.ok(found[0].contextualReason);
  assert.match(requireContextualReason(found[0]), /mutated in place/);
  for (const source of [set, foreign, zoneless]) {
    assert.deepEqual(angular(source, 'angular-default-change-detection'), []);
  }
});

const ANGULAR_WITH_ENUM = {
  'node_modules/@angular/core/index.d.ts':
    'export declare function Component(metadata: object): ClassDecorator;\nexport declare enum ChangeDetectionStrategy { OnPush = 0, Default = 1 }',
};

function onPushFix(source: string): FixResult | undefined {
  const [finding] = only(source, 'angular-default-change-detection', 'a.component.ts', ANGULAR_WITH_ENUM);
  return siteFixes['angular-default-change-detection'](siteFixInput(finding));
}

function applyEdits(source: string, edits: TextEdit[]) {
  const descending = [...edits].sort((first, second) => second.start - first.start);
  return descending.reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);
}

test('OnPush fix adds the property and the import and removes the finding', () => {
  const source = "import { Component } from '@angular/core';\n@Component({ selector: 'x' })\nexport class A {}\n";
  const fix = onPushFix(source);
  const edited = applyEdits(source, editsOf(fix));
  assert.match(edited, /import \{ Component, ChangeDetectionStrategy \} from/);
  assert.match(edited, /\{ changeDetection: ChangeDetectionStrategy\.OnPush, selector: 'x' \}/);
  assert.deepEqual(only(edited, 'angular-default-change-detection', 'a.component.ts', ANGULAR_WITH_ENUM), []);
});

test('OnPush fix reuses an existing import and handles empty metadata', () => {
  const source =
    "import { Component, ChangeDetectionStrategy } from '@angular/core';\n@Component({})\nexport class A {}\n";
  const fix = onPushFix(source);
  assert.equal(editsOf(fix).length, 1);
  const edited = applyEdits(source, editsOf(fix));
  assert.deepEqual(only(edited, 'angular-default-change-detection', 'a.component.ts', ANGULAR_WITH_ENUM), []);
});

test('OnPush fix offers nothing when the import cannot be edited', () => {
  const aliased =
    "import { Component, ChangeDetectionStrategy as Strategy } from '@angular/core';\n@Component({})\nexport class A {}\n";
  const typeOnly =
    "import type { ChangeDetectionStrategy } from '@angular/core';\nimport { Component } from '@angular/core';\n@Component({})\nexport class A {}\n";
  assert.equal(onPushFix(aliased), undefined);
  assert.equal(onPushFix(typeOnly), undefined);
});

test('vue-watch-missing-cleanup reports an unmatched window listener in onMounted', () => {
  const leaky =
    "import { onMounted } from 'vue';\nexport function setup() { onMounted(() => { window.addEventListener('resize', () => {}); }); }";
  assert.equal(only(leaky, 'vue-watch-missing-cleanup', 'setup.ts').length, 1);
});

test('vue-watch-missing-cleanup accepts unmount hooks and requires the vue import', () => {
  const cleaned =
    "import { onMounted, onUnmounted } from 'vue';\nexport function setup() { onMounted(() => { setInterval(() => {}, 1); }); onUnmounted(() => {}); }";
  const unrelated =
    'function onMounted(callback: () => void) { callback(); }\nexport function setup() { onMounted(() => { setInterval(() => {}, 1); }); }';
  assert.deepEqual(only(cleaned, 'vue-watch-missing-cleanup', 'setup.ts'), []);
  assert.deepEqual(only(unrelated, 'vue-watch-missing-cleanup', 'setup.ts'), []);
});

test('vue-v-for-missing-key reports a keyless root h() and ignores keyed, nested, foreign, and opaque props', () => {
  const head = "import { h } from 'vue';\n";
  const keyless = `${head}export const render = (rows: string[]) => rows.map((row) => h('li', row));`;
  const keyed = `${head}export const render = (rows: string[]) => rows.map((row) => h('li', { key: row }, row));`;
  const nested = `${head}export const render = (rows: string[]) => rows.map((row) => h('li', { key: row }, [h('span', row)]));`;
  const opaque = `${head}export const render = (rows: string[], props: object) => rows.map((row) => h('li', props, row));`;
  const foreign =
    "function h(tag: string, children: string) { return tag + children; }\nexport const render = (rows: string[]) => rows.map((row) => h('li', row));";
  assert.equal(only(keyless, 'vue-v-for-missing-key', 'render.ts').length, 1);
  for (const source of [keyed, nested, opaque, foreign]) {
    assert.deepEqual(only(source, 'vue-v-for-missing-key', 'render.ts'), []);
  }
});

test('dom-layout-thrashing reports a layout read next to a DOM write in one loop', () => {
  const source =
    "export function resize(items: HTMLElement[]) { for (const item of items) { const w = item.offsetWidth; item.style.width = w + 1 + 'px'; } }";
  assert.equal(only(source, 'dom-layout-thrashing', 'layout.ts').length, 1);
});

test('dom-layout-thrashing reports a nested loop once and ignores non-DOM writes', () => {
  const nested =
    'export function f(rows: HTMLElement[][]) { for (const row of rows) { for (const el of row) { el.classList.add(String(el.clientHeight)); } } }';
  const collections =
    "export function f(items: HTMLElement[]) { const seen = new Set<number>(); for (const el of items) { seen.add(el.offsetWidth); 'a'.replace('a', 'b'); } }";
  const readsOnly =
    'export function f(items: HTMLElement[]) { let total = 0; for (const el of items) { total += el.offsetHeight; } return total; }';
  assert.equal(only(nested, 'dom-layout-thrashing', 'layout.ts').length, 1);
  assert.deepEqual(only(collections, 'dom-layout-thrashing', 'layout.ts'), []);
  assert.deepEqual(only(readsOnly, 'dom-layout-thrashing', 'layout.ts'), []);
});

test('dom-layout-thrashing counts getComputedStyle geometry reads and getPropertyValue', () => {
  const geometry =
    'export function f(items: HTMLElement[]) { for (const el of items) { const w = getComputedStyle(el).width; el.style.width = w; } }';
  const lookup =
    "export function f(items: HTMLElement[]) { for (const el of items) { const w = window.getComputedStyle(el).getPropertyValue('width'); el.classList.add(w); } }";
  assert.equal(only(geometry, 'dom-layout-thrashing', 'layout.ts').length, 1);
  assert.equal(only(lookup, 'dom-layout-thrashing', 'layout.ts').length, 1);
});

test('dom-layout-thrashing ignores bare getComputedStyle, non-geometry props, and local lookalikes', () => {
  const bare =
    'export function f(items: HTMLElement[]) { for (const el of items) { getComputedStyle(el); el.classList.add("a"); } }';
  const color =
    'export function f(items: HTMLElement[]) { for (const el of items) { const c = getComputedStyle(el).color; el.classList.add(c); } }';
  const local =
    'function getComputedStyle(el: HTMLElement) { return { width: el.id }; }\nexport function f(items: HTMLElement[]) { for (const el of items) { const w = getComputedStyle(el).width; el.classList.add(w); } }';
  assert.deepEqual(only(bare, 'dom-layout-thrashing', 'layout.ts'), []);
  assert.deepEqual(only(color, 'dom-layout-thrashing', 'layout.ts'), []);
  assert.deepEqual(only(local, 'dom-layout-thrashing', 'layout.ts'), []);
});

test('dom-listener-without-cleanup is contextual and skips top-level bootstrap, signals, and named handlers', () => {
  const inFunction = "export function init() { window.addEventListener('online', () => {}); }";
  const topLevel = "window.addEventListener('online', () => {});";
  const withSignal =
    "export function init(c: AbortController) { window.addEventListener('online', () => {}, { signal: c.signal }); }";
  const named = "export function init() { window.addEventListener('online', handler); }\nfunction handler() {}";
  const element = "export function init(el: HTMLElement) { el.addEventListener('click', () => {}); }";
  const found = only(inFunction, 'dom-listener-without-cleanup', 'init.ts');
  assert.equal(found.length, 1);
  assert.ok(found[0].contextualReason);
  assert.match(requireContextualReason(found[0]), /lifetime of the app/);
  for (const source of [topLevel, withSignal, named, element]) {
    assert.deepEqual(only(source, 'dom-listener-without-cleanup', 'init.ts'), []);
  }
});

test('dom-listener-without-cleanup leaves effect listeners to react-missing-cleanup', () => {
  const source = `${REACT_IMPORT}export function A() { useEffect(() => { window.addEventListener('keydown', () => {}); }, []); return null; }`;
  assert.deepEqual(only(source, 'dom-listener-without-cleanup'), []);
  assert.equal(only(source, 'react-missing-cleanup').length, 1);
});

test('dom-unthrottled-scroll-resize is firm when the handler measures layout', () => {
  const source =
    "window.addEventListener('scroll', () => { document.body.style.top = document.body.scrollTop + 'px'; });";
  const found = only(source, 'dom-unthrottled-scroll-resize', 'scroll.ts');
  assert.equal(found.length, 1);
  assert.equal(found[0].contextualReason, undefined);
});

test('dom-unthrottled-scroll-resize is contextual for cheap or unseen handlers', () => {
  const cheap = "let y = 0;\nwindow.addEventListener('scroll', () => { y = 1; });";
  const imported = "import { onScroll } from './other';\nwindow.addEventListener('scroll', onScroll);";
  const { contextualReason } = only(cheap, 'dom-unthrottled-scroll-resize', 'scroll.ts')[0];
  assert.ok(contextualReason);
  assert.match(contextualReason, /cheap/);
  const unseen = only(imported, 'dom-unthrottled-scroll-resize', 'scroll.ts', {
    'other.ts': 'export function onScroll() {}',
  });
  assert.ok(unseen.length <= 1);
});

test('dom-unthrottled-scroll-resize skips wrapped, scheduled, passive, and non-DOM listeners', () => {
  const wrapped =
    "declare function throttle<T>(fn: T): T;\nwindow.addEventListener('resize', throttle(() => { document.body.scrollTop; }));";
  const wrappedVariable =
    "declare function debounce<T>(fn: T): T;\nconst onResize = debounce(() => {});\nwindow.addEventListener('resize', onResize);";
  const scheduled =
    "window.addEventListener('scroll', () => { requestAnimationFrame(() => { document.body.scrollTop; }); });";
  const passive = "window.addEventListener('wheel', () => { document.body.scrollTop; }, { passive: true });";
  const emitter =
    "declare const bus: { addEventListener(name: string, handler: () => void): void };\nbus.addEventListener('scroll', () => {});";
  for (const source of [wrapped, wrappedVariable, scheduled, passive, emitter]) {
    assert.deepEqual(only(source, 'dom-unthrottled-scroll-resize', 'scroll.ts'), []);
  }
});

function passiveFixFor(source: string): FixResult | undefined {
  const [finding] = only(source, 'dom-unthrottled-scroll-resize', 'scroll.ts');
  return siteFixes['dom-unthrottled-scroll-resize'](siteFixInput(finding));
}

test('passive fix adds the option for wheel handlers without preventDefault and removes the finding', () => {
  const source = "window.addEventListener('wheel', () => { document.body.scrollTop; });";
  const edits = editsOf(passiveFixFor(source));
  const edited = source.slice(0, edits[0].start) + edits[0].text + source.slice(edits[0].end);
  assert.match(edited, /\}, \{ passive: true \}\);/);
  assert.deepEqual(only(edited, 'dom-unthrottled-scroll-resize', 'scroll.ts'), []);
});

test('passive fix also covers touchstart handlers without preventDefault', () => {
  const source = "window.addEventListener('touchstart', () => { document.body.scrollTop; });";
  const edits = editsOf(passiveFixFor(source));
  assert.equal(edits[0].text, ', { passive: true }');
  assert.deepEqual(only(applyEdits(source, edits), 'dom-unthrottled-scroll-resize', 'scroll.ts'), []);
});

test('passive fix declines scroll, preventDefault handlers, and named handlers', () => {
  assert.equal(passiveFixFor("window.addEventListener('scroll', () => { document.body.scrollTop; });"), undefined);
  assert.equal(
    passiveFixFor("window.addEventListener('wheel', (event) => { event.preventDefault(); document.body.scrollTop; });"),
    undefined,
  );
  assert.equal(
    passiveFixFor("function h() { document.body.scrollTop; }\nwindow.addEventListener('wheel', h);"),
    undefined,
  );
});

test('frontend-barrel-heavy-import reports lodash and moment in client modules only', () => {
  const client =
    "import _ from 'lodash';\nimport moment from 'moment';\nexport const A = () => <div>{String(_.debounce)}{String(moment)}</div>;";
  const server = "import _ from 'lodash';\nexport const x = _.debounce;";
  assert.equal(only(client, 'frontend-barrel-heavy-import').length, 2);
  assert.deepEqual(only(server, 'frontend-barrel-heavy-import', 'server.ts'), []);
});

test('frontend-barrel-heavy-import treats a framework import as client evidence and named lodash as contextual', () => {
  const source =
    "import { Component } from '@angular/core';\nimport { debounce } from 'lodash';\nexport const x = [Component, debounce];";
  const found = only(source, 'frontend-barrel-heavy-import', 'widget.ts');
  assert.equal(found.length, 1);
  assert.ok(found[0].contextualReason);
});

test('frontend-barrel-heavy-import skips type-only imports, subpaths, and date-fns', () => {
  const source =
    "import type _ from 'lodash';\nimport debounce from 'lodash/debounce';\nimport * as dateFns from 'date-fns';\nexport const A = () => <div>{String(debounce)}{String(dateFns)}</div>;";
  assert.deepEqual(only(source, 'frontend-barrel-heavy-import'), []);
});

test('frontend-barrel-heavy-import reports Font Awesome namespace imports as firm findings', () => {
  const source =
    "import * as solid from '@fortawesome/free-solid-svg-icons';\nimport * as brands from '@fortawesome/free-brands-svg-icons';\nexport const A = () => <div>{String(solid)}{String(brands)}</div>;";
  const found = only(source, 'frontend-barrel-heavy-import');
  assert.equal(found.length, 2);
  assert.ok(found.every((finding: Finding) => !finding.contextualReason));
});

test('frontend-barrel-heavy-import skips named Font Awesome imports', () => {
  const source =
    "import { faUser } from '@fortawesome/free-solid-svg-icons';\nexport const A = () => <div>{String(faUser)}</div>;";
  assert.deepEqual(only(source, 'frontend-barrel-heavy-import'), []);
});

test('frontend-barrel-heavy-import reports named root MUI icon imports as contextual', () => {
  const source = "import { Delete } from '@mui/icons-material';\nexport const A = () => <div>{String(Delete)}</div>;";
  const found = only(source, 'frontend-barrel-heavy-import');
  assert.equal(found.length, 1);
  assert.ok(found[0].contextualReason);
  assert.match(requireContextualReason(found[0]), /path imports/);
});

test('frontend-barrel-heavy-import skips MUI icon subpath imports', () => {
  const source =
    "import Delete from '@mui/icons-material/Delete';\nexport const A = () => <div>{String(Delete)}</div>;";
  assert.deepEqual(only(source, 'frontend-barrel-heavy-import'), []);
});

test('rules skip test sources', () => {
  const source = "export function init() { window.addEventListener('online', () => {}); }";
  assert.deepEqual(findings(source, 'init.test.ts'), []);
});
