// Security rules run on a virtual program. `lint` includes the stub packages a test passes;
// `lintWithoutTypes` drops every node_modules file, as in a cloned project that was never
// installed. `lintBothWays` runs both and fails unless the findings without types are a subset of
// the findings with types.
import assert from 'node:assert/strict';
import { withProgram } from '../performance/helpers.js';
import type { Expression, Node, SourceFile } from 'typescript';
import type { ProgramAdapter, RulePolicy, SecurityRuleContext } from '../../lib/shared/types.js';
import type { LocatedFinding, SecReport } from '../types/security.js';
import type { SecurityCheckModule } from '../../lib/security/types/security-check.js';
import { analyzeFile, createAnalyzer } from '../../lib/security/analyze.js';
import * as ts from 'typescript';

type FileMap = Record<string, string>;
type Analyze = (program: ProgramAdapter, sourceFile: SourceFile, policy?: RulePolicy) => LocatedFinding[];

const nodeTypesPrefix = 'node_modules/@types/node/';

function localFiles(files: FileMap): FileMap {
  return Object.fromEntries(Object.entries(files).filter(([name]) => !name.split('/').includes('node_modules')));
}

// Stubs under @types/node only load when the program asks for them, as an installed project's
// tsconfig would.
function compilerOptions(files: FileMap): Record<string, string[]> {
  return Object.keys(files).some((name) => name.startsWith(nodeTypesPrefix)) ? { types: ['node'] } : {};
}

function runProgram<Result>(
  source: string,
  files: FileMap,
  callback: (program: ProgramAdapter, sourceFile: SourceFile) => Result,
): Result {
  return withProgram(source, files, callback, compilerOptions(files));
}

function analyzeWith(analyzeFile: Analyze) {
  return (source: string, files: FileMap = {}, policy?: RulePolicy): LocatedFinding[] =>
    runProgram(source, files, (program: ProgramAdapter, sourceFile: SourceFile) =>
      analyzeFile(program, sourceFile, policy),
    );
}

function lint(source: string, files: FileMap = {}, policy?: RulePolicy): LocatedFinding[] {
  return analyzeWith(analyzeFile)(source, files, policy);
}

function lintWithoutTypes(source: string, files: FileMap = {}, policy?: RulePolicy): LocatedFinding[] {
  return lint(source, localFiles(files), policy);
}

const findingKey = ({ line, column, ruleId }: LocatedFinding) => `${line}:${column}:${ruleId}`;

function lintBothWays(
  source: string,
  files: FileMap = {},
  policy?: RulePolicy,
): { typed: LocatedFinding[]; untyped: LocatedFinding[] } {
  const typed = lint(source, files, policy);
  const untyped = lintWithoutTypes(source, files, policy);
  const typedKeys = new Set(typed.map(findingKey));
  const extra = untyped.map(findingKey).filter((key: string) => !typedKeys.has(key));
  assert.deepEqual(extra, [], 'findings reported only without types');
  return { typed, untyped };
}

// Runs `callback(context, sourceFile)` with a security context for the virtual program; for engine
// tests.
function withContext<Result>(
  source: string,
  files: FileMap,
  callback: (context: SecurityRuleContext, sourceFile: SourceFile) => Result,
): Result | undefined {
  let result: Result | undefined;
  const probe: SecurityCheckModule = {
    checks: {
      SourceFile: [
        (sourceFile: SourceFile, context: SecurityRuleContext) => {
          result = callback(context, sourceFile);
        },
      ],
    },
  };
  runProgram(source, files, (program: ProgramAdapter, sourceFile: SourceFile) =>
    createAnalyzer([probe])(program, sourceFile),
  );
  return result;
}

// The expression passed as the only argument of the first call to `sink(...)` in the file.
function sinkArgument(sourceFile: SourceFile, name = 'sink'): Expression {
  let found: Expression | undefined;
  (function visit(node: Node): void {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name)
      found = node.arguments[0];
    ts.forEachChild(node, visit);
  })(sourceFile);
  if (!found) throw new Error(`no ${name}() call in the fixture`);
  return found;
}

// The source file of the virtual program whose name ends with `fileName`.
function sourceFileNamed(program: ProgramAdapter, fileName: string): SourceFile {
  assert.ok(program.getSourceFiles, 'the program lists its source files');
  const sourceFile = program.getSourceFiles().find((candidate) => candidate.fileName.endsWith(fileName));
  assert.ok(sourceFile, `no ${fileName} in the fixture program`);
  return sourceFile;
}

function parseSecReport(stdout: string): SecReport {
  return JSON.parse(stdout);
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
      'export declare function UsePipes(...pipes: unknown[]): MethodDecorator & ClassDecorator;',
      'export declare class ParseIntPipe {}',
      'export declare class ParseFloatPipe {}',
      'export declare class ParseBoolPipe {}',
      'export declare class ParseUUIDPipe {}',
      'export declare class ParseEnumPipe { constructor(type: object) }',
      'export declare class ValidationPipe { constructor(options?: object) }',
    ].join('\n'),
    'node_modules/@nestjs/mapped-types/index.d.ts':
      'export declare function PartialType<T>(type: new () => T): new () => Partial<T>;',
  },
  classValidator: {
    'node_modules/class-validator/index.d.ts': [
      'IsInt',
      'IsUUID',
      'IsString',
      'IsEmail',
      'Matches',
      'ValidateIf',
      'IsIn',
    ]
      .map((name) => `export declare function ${name}(...options: unknown[]): PropertyDecorator;`)
      .join('\n'),
  },
  // Schema libraries typed as `any`, so the typed run prunes nothing the untyped run keeps.
  schemas: {
    'node_modules/zod/index.d.ts': 'export declare const z: any;',
    'node_modules/joi/index.d.ts': 'declare const Joi: any; export default Joi;',
    'node_modules/yup/index.d.ts': 'export declare const object: any, string: any, number: any;',
    'node_modules/valibot/index.d.ts':
      'export declare const object: any, string: any, uuid: any, pipe: any, parse: any;',
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

export {
  lint,
  lintWithoutTypes,
  lintBothWays,
  withContext,
  sinkArgument,
  sourceFileNamed,
  parseSecReport,
  stubs,
  localFiles,
};
