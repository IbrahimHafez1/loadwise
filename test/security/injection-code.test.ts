// code-injection and template-injection: request data evaluated as code or compiled as a template.
// Constant code, functions passed to timers and request data passed only as template data are
// silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintBothWays, lintWithoutTypes, stubs } from './helpers.js';
import type { LocatedFinding } from '../types/security.js';

const packages = {
  ...stubs.express,
  'node_modules/@types/node/index.d.ts': [
    "declare module 'vm' { export function runInNewContext(code: string, context?: object): unknown;",
    '  export class Script { constructor(code: string) } }',
    'declare function setTimeout(handler: unknown, delay?: number): unknown;',
    'declare function require(id: string): any;',
  ].join('\n'),
  'node_modules/ejs/index.d.ts': 'export declare function render(template: string, data?: object): string;',
  'node_modules/handlebars/index.d.ts':
    'declare const Handlebars: { compile(template: string): (data: object) => string }; export default Handlebars;',
  'node_modules/lodash/index.d.ts': 'export declare function template(text: string): (data: object) => string;',
  'node_modules/node-serialize/index.d.ts': 'export declare function unserialize(text: string): unknown;',
};

function route(...body: string[]) {
  return [
    "import express from 'express';",
    "import * as vm from 'vm';",
    "import { render } from 'ejs';",
    "import Handlebars from 'handlebars';",
    "import * as _ from 'lodash';",
    "import { unserialize } from 'node-serialize';",
    'const app = express();',
    "app.post('/x', (req, res) => {",
    ...body,
    '});',
  ].join('\n');
}

function findings(source: string, ruleId: string) {
  const { typed } = lintBothWays(source, packages);
  return typed
    .filter((finding: LocatedFinding) => finding.ruleId === ruleId)
    .map((finding: LocatedFinding) => finding.line);
}

test('request data evaluated as code is reported', () => {
  const source = route(
    'eval(req.body.expression);',
    "const body = req.body.code;\nnew Function('x', body);",
    'vm.runInNewContext(req.body.code, {});',
    'new vm.Script(`(${req.query.fn})`);',
    'setTimeout(req.query.callback, 10);',
    'require(req.query.plugin);',
    'import(`./plugins/${req.query.plugin}`);',
    'unserialize(req.cookies.profile);',
  );
  assert.deepEqual(findings(source, 'code-injection'), [9, 11, 12, 13, 14, 15, 16, 17]);
  assert.equal(
    lintWithoutTypes(source, packages)[0].message,
    '`req.body.expression` is evaluated as code here. Parse the input as data (`JSON.parse`, a schema) or map it to a fixed set of functions.',
  );
});

test('constant code, functions passed to timers, guarded plugin names and parsed data are silent', () => {
  const source = route(
    "eval('1 + 1');",
    'setTimeout(() => res.send(req.body), 10);',
    "const PLUGINS = ['csv', 'pdf'];",
    'const plugin = req.query.plugin;',
    "if (!PLUGINS.includes(plugin)) throw new Error('unknown plugin');",
    'import(`./plugins/${plugin}`);',
    'JSON.parse(req.body.payload);',
    'const local = { eval(text: string) {} };',
    'local.eval(req.body.expression);',
  );
  assert.deepEqual(findings(source, 'code-injection'), []);
});

test('request data compiled as a template is reported; request data as template data is not', () => {
  const source = route(
    'render(req.body.template, {});',
    'Handlebars.compile(req.body.layout);',
    '_.template(`Hello ${req.query.name}`);',
    "render('<h1><%= name %></h1>', { name: req.body.name });",
    "Handlebars.compile('{{name}}')({ name: req.body.name });",
  );
  assert.deepEqual(findings(source, 'template-injection'), [9, 10, 11]);
  const [finding] = lintWithoutTypes(source, packages).filter((item) => item.ruleId === 'template-injection');
  assert.equal(
    finding.message,
    '`req.body.template` is compiled as a template, which lets a caller run template code on the server. Keep templates fixed and pass input only as data.',
  );
});

test('a render method that is not from a template library is not a sink', () => {
  const source = route('const view = { render(text: string) {} };', 'view.render(req.body.template);');
  assert.deepEqual(findings(source, 'template-injection'), []);
});

test('a request value reaching an evaluating helper is reported in the helper', () => {
  const source = [
    "import express from 'express';",
    'function calculate(expression: string) { return eval(expression); }',
    'const app = express();',
    "app.post('/x', (req, res) => res.send(calculate(req.body.expression)));",
  ].join('\n');
  assert.deepEqual(findings(source, 'code-injection'), [2]);
});

test('eval of text derived from a function parameter is contextual, constant text is silent', () => {
  const evaluate = (body: string) =>
    lintWithoutTypes(`export function run(value) { ${body} }`, packages).filter(
      (finding: LocatedFinding) => finding.ruleId === 'code-injection',
    );
  const [finding] = evaluate("return eval('(' + value.slice(2) + ')');");
  assert.match(finding.contextualReason ?? '', /function parameter/);
  assert.equal(evaluate("return eval('1 + 1');").length, 0);
  assert.equal(evaluate('return require(value);').length, 0);
  assert.equal(evaluate('return setTimeout(value, 10);').length, 0);
});

test('a spread argument and a local alias of a global evaluator are still sinks', () => {
  const source = route(
    'new Function(...req.body.parts);',
    'const run = eval;',
    'run(req.body.expression);',
    'const Constructor = Function;',
    'new Constructor(req.body.code);',
    'const local = (text: string) => text;\nconst safe = local;\nsafe(req.body.expression);',
  );
  assert.deepEqual(findings(source, 'code-injection'), [9, 11, 13]);
});
