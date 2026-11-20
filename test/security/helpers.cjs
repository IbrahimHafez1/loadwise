'use strict';

// Security rules run on a virtual program. `lint` includes the stub packages a test passes; `lintWithoutTypes`
// drops every node_modules file, as in a cloned project that was never installed. `lintBothWays` runs both and
// fails unless the findings without types are a subset of the findings with types.
const assert = require('node:assert/strict');
const { withProgram } = require('../performance/helpers.cjs');

const nodeTypesPrefix = 'node_modules/@types/node/';

function localFiles(files) {
  return Object.fromEntries(Object.entries(files).filter(([name]) => !name.split('/').includes('node_modules')));
}

// Stubs under @types/node only load when the program asks for them, as an installed project's tsconfig would.
function compilerOptions(files) {
  return Object.keys(files).some((name) => name.startsWith(nodeTypesPrefix)) ? { types: ['node'] } : {};
}

function runProgram(source, files, callback) {
  return withProgram(source, files, callback, compilerOptions(files));
}

function analyzeWith(analyzeFile) {
  return (source, files = {}, policy) =>
    runProgram(source, files, (program, sourceFile) => analyzeFile(program, sourceFile, policy));
}

function lint(source, files = {}, policy) {
  return analyzeWith(require('../../lib/security/analyze.cjs').analyzeFile)(source, files, policy);
}

function lintWithoutTypes(source, files = {}, policy) {
  return lint(source, localFiles(files), policy);
}

const findingKey = ({ line, column, ruleId }) => `${line}:${column}:${ruleId}`;

function lintBothWays(source, files = {}, policy) {
  const typed = lint(source, files, policy);
  const untyped = lintWithoutTypes(source, files, policy);
  const typedKeys = new Set(typed.map(findingKey));
  const extra = untyped.map(findingKey).filter((key) => !typedKeys.has(key));
  assert.deepEqual(extra, [], 'findings reported only without types');
  return { typed, untyped };
}

// Runs `callback(context, sourceFile)` with a security context for the virtual program; for engine tests.
function withContext(source, files, callback) {
  const { createAnalyzer } = require('../../lib/security/analyze.cjs');
  let result;
  const probe = {
    checks: {
      SourceFile: [
        (sourceFile, context) => {
          result = callback(context, sourceFile);
        },
      ],
    },
  };
  runProgram(source, files, (program, sourceFile) => createAnalyzer([probe])(program, sourceFile));
  return result;
}

// The expression passed as the only argument of the first call to `sink(...)` in the file.
function sinkArgument(sourceFile, name = 'sink') {
  const ts = require('typescript');
  let found;
  (function visit(node) {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name)
      found = node.arguments[0];
    ts.forEachChild(node, visit);
  })(sourceFile);
  if (!found) throw new Error(`no ${name}() call in the fixture`);
  return found;
}

// Minimal declaration packages. Each entry is a path under the virtual project and its contents.
const stubs = {
  express: {
    'node_modules/express/index.d.ts': [
      'export interface Request { body: any; query: Record<string, string>; params: Record<string, string>;',
      '  headers: Record<string, string>; user?: { id: string }; get(name: string): string | undefined }',
      'export interface Response { send(body: unknown): Response; redirect(url: string): void }',
      'export interface Router { get(path: string, ...handlers: ((req: Request, res: Response) => unknown)[]): Router;',
      '  post(path: string, ...handlers: ((req: Request, res: Response) => unknown)[]): Router }',
      'export function Router(): Router;',
      'declare function express(): Router; export default express;',
    ].join('\n'),
  },
  nest: {
    'node_modules/@nestjs/common/index.d.ts': [
      'export declare function Controller(path?: string): ClassDecorator;',
      'export declare function Get(path?: string): MethodDecorator;',
      'export declare function Post(path?: string): MethodDecorator;',
      'export declare function Body(property?: string, ...pipes: unknown[]): ParameterDecorator;',
      'export declare function Query(property?: string, ...pipes: unknown[]): ParameterDecorator;',
      'export declare function Param(property?: string, ...pipes: unknown[]): ParameterDecorator;',
      'export declare function Headers(property?: string): ParameterDecorator;',
      'export declare function Req(): ParameterDecorator;',
      'export declare function UploadedFile(): ParameterDecorator;',
      'export declare class ParseIntPipe {}',
    ].join('\n'),
  },
  childProcess: {
    'node_modules/@types/node/index.d.ts': [
      "declare module 'child_process' {",
      '  export function exec(command: string): void;',
      '  export function execFile(file: string, args: string[]): void;',
      '}',
      "declare module 'node:child_process' { export * from 'child_process'; }",
    ].join('\n'),
  },
  typeorm: {
    'node_modules/typeorm/index.d.ts': [
      'export declare class DataSource { query(text: string, parameters?: unknown[]): Promise<unknown>;',
      '  createQueryBuilder(alias: string): SelectQueryBuilder }',
      'export declare class SelectQueryBuilder { where(text: string, parameters?: object): SelectQueryBuilder }',
    ].join('\n'),
  },
};

module.exports = { lint, lintWithoutTypes, lintBothWays, withContext, sinkArgument, stubs, localFiles };
