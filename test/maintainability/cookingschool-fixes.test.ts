// Fix shapes found in a NestJS backend: identical private controller methods, a forwarded type with
// no consumers, and the naming and placement of shared duplicate helpers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { applyFix } from '../../editor/apply-fix.cjs';
import { applyChangesToText } from '../../lib/maintainability/apply-fix.js';
import { buildFix, createFileCache, attachSiteFixes } from '../../lib/maintainability/site-fix.js';
import { scan } from '../../lib/maintainability/scan.js';
import { defaultLimits } from '../../lib/maintainability/limits.js';
import { applyBulkFixes } from '../../lib/shared/fix.js';
import type { TestContext } from 'node:test';
import { fixOf } from '../types/finding-fix.js';
import type { FindingFix, FixChange } from '../../lib/shared/types.js';
import type { LocatedFinding } from '../../lib/maintainability/types/module-graph.js';
import type { MaintainabilityPolicy } from '../../lib/maintainability/types/policy.js';
import type { FileMap } from '../types/project-files.js';

interface Greeter {
  greet(request: { headers: Record<string, string> }): string;
}

interface ColumnModule {
  config: { columns: { parse(value: unknown): unknown; format(value: unknown): unknown }[] };
}

function writeProject(context: TestContext, files: FileMap) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-cookingschool-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

// A duplicate-implementation finding over every line in `files` that contains `marker`.
function duplicateFinding(files: FileMap, marker: string): LocatedFinding {
  const sites = Object.entries(files).flatMap(([file, text]) =>
    text
      .split('\n')
      .flatMap((line, index) =>
        line.includes(marker) ? [{ file, line: index + 1, column: line.indexOf(marker) + 1 }] : [],
      ),
  );
  return {
    ...sites[0],
    related: sites.slice(1),
    ruleId: 'duplicate-implementation',
    message: 'duplicate implementation',
  };
}

function applyTo(root: string, fix: Pick<FindingFix, 'changes'>) {
  const result = applyFix(fix, {
    readFile: (file) => fs.readFileSync(path.join(root, file), 'utf8'),
    writeFile: (file, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    },
  });
  assert.equal(result.error, undefined);
}

function typeErrors(root: string, files: readonly string[]) {
  const options = { strict: true, noUnusedLocals: true, noEmit: true, target: ts.ScriptTarget.ES2022, types: [] };
  const program = ts.createProgram(
    files.map((file) => path.join(root, file)),
    options,
  );
  return ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, ' '));
}

function compileAll(root: string, files: readonly string[]) {
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    fs.writeFileSync(path.join(root, file.replace(/\.ts$/, '.js')), output);
  }
}

const languageMethod = [
  '  private detectLanguage(request: Request): string {',
  "    const header = request.headers['accept-language'];",
  "    const lang = header?.split(',')[0]?.toLowerCase();",
  '    if (lang && SUPPORTED.includes(lang)) return lang;',
  "    return 'en';",
  '  }',
].join('\n');

function controller(name: string, depth: number, method = languageMethod, extra = '') {
  const up = '../'.repeat(depth);
  return [
    `import { SUPPORTED } from '${up}languages';`,
    `import type { Request } from '${up}http';`,
    extra,
    `export class ${name} {`,
    "  prefix = 'hello';",
    method,
    '',
    '  greet(request: Request): string {',
    "    return 'hello:' + this.detectLanguage(request);",
    '  }',
    '}',
    '',
  ].join('\n');
}

const support = {
  'src/http.ts': 'export interface Request { headers: Record<string, string | undefined> }\n',
  'src/languages.ts': "export const SUPPORTED: string[] = ['en', 'ar'];\n",
};
const controllers = {
  'src/orders/orders.controller.ts': controller('OrdersController', 1),
  'src/users/users.controller.ts': controller('UsersController', 1),
  'src/users/admin/admin.controller.ts': controller('AdminController', 2),
};

test('identical private methods across files give way to calls of one exported function that type-checks', async (context) => {
  const files = { ...support, ...controllers };
  const root = writeProject(context, files);
  const fix = buildFix(duplicateFinding(controllers, 'detectLanguage(request: Request)'), createFileCache(root));
  assert.ok(fix, 'expected a fix');
  assert.equal(fix.requiresReview, true);
  const created = fix.changes.find((change: FixChange) => change.create);
  assert.ok(created);
  assert.equal(created.file, 'src/detect-language.ts');
  assert.match(
    created.after,
    /^import type \{ Request \} from '\.\/http';\nimport \{ SUPPORTED \} from '\.\/languages';/,
  );
  assert.match(created.after, /\nexport function detectLanguage\(request: Request\): string \{\n {2}const header/);
  applyTo(root, fix);
  const admin = fs.readFileSync(path.join(root, 'src/users/admin/admin.controller.ts'), 'utf8');
  assert.doesNotMatch(admin, /SUPPORTED/);
  assert.match(admin, /import \{ detectLanguage \} from '\.\.\/\.\.\/detect-language';/);
  assert.doesNotMatch(admin, /private detectLanguage/);
  assert.match(admin, /return 'hello:' \+ detectLanguage\(request\);/);
  const all = [...Object.keys(files), created.file];
  assert.deepEqual(typeErrors(root, all), []);
  compileAll(root, all);
  for (const [file, name] of [
    ['src/orders/orders.controller.js', 'OrdersController'],
    ['src/users/admin/admin.controller.js', 'AdminController'],
  ]) {
    const loaded: Record<string, new () => Greeter> = await import(pathToFileURL(path.join(root, file)).href);
    const Controller = loaded[name];
    assert.ok(Controller);
    const instance = new Controller();
    assert.equal(instance.greet({ headers: { 'accept-language': 'AR,en' } }), 'hello:ar');
    assert.equal(instance.greet({ headers: {} }), 'hello:en');
  }
});

test('a private method that reads this, differs, or uses a module-private name keeps its own body', (context) => {
  const variants = [
    languageMethod.replace("return 'en';", 'return this.prefix;'),
    languageMethod.replace("return 'en';", "return 'ar';"),
    languageMethod.replace("return 'en';", 'return fallback;'),
    languageMethod.replace("    return 'en';", "    // Arabic speakers fall back to English.\n    return 'en';"),
  ];
  for (const method of variants) {
    const changed: FileMap = {
      ...controllers,
      'src/users/users.controller.ts': controller('UsersController', 1, method, "const fallback = 'en';"),
    };
    if (method.includes('fallback'))
      for (const file of Object.keys(changed))
        changed[file] = controller('Controller', file.split('/').length - 2, method, "const fallback = 'en';");
    const root = writeProject(context, { ...support, ...changed });
    const finding = duplicateFinding(changed, 'detectLanguage(request: Request)');
    const fix = buildFix(finding, createFileCache(root));
    // The other two identical copies may still share a function; the odd one is never rewritten.
    assert.equal(
      Boolean(fix?.changes.some((change: FixChange) => change.file === 'src/users/users.controller.ts')),
      false,
      method,
    );
  }
});

async function unusedExportFindings(context: TestContext, adjust: string) {
  const root = writeProject(context, {
    'package.json': '{"private":true}',
    'src/index.ts': "import { run } from './adjust';\nrun();\n",
    'src/schema.ts': 'export type Pending = { id: string };\nexport const unit = 1;\n',
    'src/adjust.ts': adjust,
  });
  const policy: MaintainabilityPolicy = { exclude: [], boundaries: [], placement: [], limits: defaultLimits };
  const report = await scan(root, policy);
  return report.findings.filter((finding) => finding.ruleId === 'unused-export' && finding.file === 'src/adjust.ts');
}

const reexporting = [
  "import { unit } from './schema';",
  "import type { Pending } from './schema';",
  '',
  'export type { Pending };',
  '',
  'export function run(): number {',
  '  return unit;',
  '}',
  '',
].join('\n');

test('an unused type re-export is removed together with its type-only import', async (context) => {
  const [finding] = await unusedExportFindings(context, reexporting);
  assert.match(finding.message, /`Pending`/);
  const fix = fixOf(finding);
  assert.equal(fix.requiresReview, true);
  assert.match(String(fix.note), /^Removes the re-export and the type-only import/);
  const fixed = applyChangesToText(reexporting, fix.changes).text;
  assert.equal(
    fixed,
    reexporting.replace("import type { Pending } from './schema';\n", '').replace('export type { Pending };\n\n', ''),
  );
});

test('a type re-export keeps its import when the file still uses the type', async (context) => {
  for (const source of [
    reexporting.replace('run(): number', 'run(pending?: Pending): number'),
    reexporting.replace('import type { Pending }', 'import { type Pending }'),
  ]) {
    const [finding] = await unusedExportFindings(context, source);
    assert.match(finding.message, /`Pending`/);
    assert.equal(finding.fix, undefined, source);
  }
});

const arrowBody = ['{', '  const secure = !!settings.domain;', '  return { secure, age: Number(expiry) };', '}'].join(
  '\n',
);
function arrowModule(names: readonly string[], extra = '') {
  return [
    "export const settings = { domain: '' };",
    ...names.map(
      (name) => `/** Options for ${name}. */\nexport const ${name} = (expiry: string): object => ${arrowBody};`,
    ),
    extra,
  ].join('\n');
}

test('two exported arrows share a helper named for what their names have in common', (context) => {
  const names = ['getAccessTokenOptions', 'getRefreshTokenOptions'];
  const files = { 'options.ts': arrowModule(names) };
  const root = writeProject(context, files);
  const fix = buildFix(duplicateFinding(files, 'TokenOptions = ('), createFileCache(root));
  assert.ok(fix);
  const after = fix.changes.map((change: FixChange) => change.after).join('\n');
  assert.match(after, /function getTokenOptions\(expiry: string\): object \{/);
  assert.match(after, /export const getRefreshTokenOptions = \(expiry: string\): object => getTokenOptions\(expiry\)/);
  assert.doesNotMatch(after, /Implementation/);
});

test('a shared arrow helper falls back to the Implementation name when the common name is taken', (context) => {
  const files = {
    'options.ts': arrowModule(['getAccessTokenOptions', 'getRefreshTokenOptions'], 'const getTokenOptions = 1;'),
  };
  const root = writeProject(context, files);
  const fix = buildFix(duplicateFinding(files, 'TokenOptions = ('), createFileCache(root));
  assert.ok(fix);
  assert.match(fix.changes.map((change: FixChange) => change.after).join('\n'), /getAccessTokenOptionsImplementation/);
});

const columnSchema =
  'export interface Config { columns: Array<{ key: string; parse(value: unknown, row?: number): unknown; format(value: unknown): unknown }> };';
const columnCallbacks = [
  '      parse: (value) => {',
  '        if (value == null) return null;',
  '        return new Date(String(value));',
  '      },',
  '      format: (value) => {',
  "        if (value instanceof Date) return value.toISOString().split('T')[0];",
  '        return String(value);',
  '      },',
].join('\n');
function columnConfig(keys: readonly string[]) {
  return [
    "import type { Config } from './schema';",
    '',
    '/** Column mapping. */',
    'export const config: Config = {',
    '  columns: [',
    ...keys.flatMap((key) => ['    {', `      key: '${key}',`, columnCallbacks, '    },']),
    '  ],',
    '};',
    '',
  ].join('\n');
}

function configFindings(context: TestContext, source: string) {
  const root = writeProject(context, { 'columns.ts': source, 'schema.ts': columnSchema });
  const findings = ['parse', 'format'].map((name) => ({
    ...duplicateFinding({ 'columns.ts': source }, `${name}: (value) =>`),
    id: name,
    checker: 'maint',
  }));
  for (const finding of findings) finding.column += finding.id.length + 2;
  attachSiteFixes(findings, root, { comments: false });
  return { findings, root };
}

test('duplicated column callbacks become named helpers above the config that each field references', (context) => {
  const source = columnConfig(['discountStartDate', 'discountEndDate']);
  const { findings, root } = configFindings(context, source);
  // Applied together, as the identical columns make each change's original lines ambiguous after
  // the other.
  assert.equal(applyBulkFixes(findings, root, { includeReview: true }).changedFiles, 1);
  const fixed = fs.readFileSync(path.join(root, 'columns.ts'), 'utf8');
  assert.match(
    fixed,
    /\n\nfunction parseDiscountDate\(value: unknown\) \{[\s\S]*\n\nfunction formatDiscountDate\(value: unknown\) \{[\s\S]*\}\n\n\/\*\* Column mapping\. \*\//,
  );
  assert.equal(fixed.match(/parse: parseDiscountDate,/g)?.length, 2);
  assert.equal(fixed.match(/format: formatDiscountDate,/g)?.length, 2);
  assert.doesNotMatch(fixed, /\n\n\n/);
  const output = ts.transpileModule(fixed, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exported: ColumnModule = { config: { columns: [] } };
  Function('exports', output)(exported);
  const [column] = exported.config.columns;
  assert.equal(column.parse(null), null);
  assert.equal(column.format(new Date('2024-02-03T00:00:00Z')), '2024-02-03');
});

test('column callbacks without a shared field key keep the configuration-based helper names', (context) => {
  const { findings } = configFindings(context, columnConfig(['opensAt', 'closedOn']));
  const after = findings
    .map((finding) =>
      fixOf(finding)
        .changes.map((change: FixChange) => change.after)
        .join('\n'),
    )
    .join('\n');
  assert.match(after, /function configParse\(/);
  assert.match(after, /function configFormat\(/);
});

const parseHelper = [
  '// Parses a JSON-encoded form field.',
  'function parseJsonArray(value: unknown): unknown {',
  "  if (typeof value !== 'string') return value;",
  '  return JSON.parse(value);',
  '}',
].join('\n');
const dto = [
  "import { IsString } from 'class-validator';",
  "import { Entry } from './entry';",
  '',
  parseHelper,
  '',
  'export class Dto {',
  '  entries = parseJsonArray(Entry.raw);',
  '  check = IsString;',
  '}',
  '',
].join('\n');

test('a shared sibling helper takes its own name and its import follows the relative imports', (context) => {
  const files = { 'dto/create.dto.ts': dto, 'dto/update.dto.ts': dto };
  const root = writeProject(context, { ...files, 'dto/entry.ts': 'export const Entry = { raw: "[]" };\n' });
  const fix = buildFix(duplicateFinding(files, 'function parseJsonArray'), createFileCache(root));
  assert.ok(fix);
  assert.equal(fix.changes.find((change: FixChange) => change.create)?.file, 'dto/parse-json-array.ts');
  applyTo(root, fix);
  assert.equal(
    fs.readFileSync(path.join(root, 'dto/create.dto.ts'), 'utf8'),
    dto.replace(
      "from './entry';\n\n" + parseHelper + '\n',
      "from './entry';\nimport { parseJsonArray } from './parse-json-array';\n",
    ),
  );
});

test('a shared sibling helper is withheld when a file already has its name', (context) => {
  const files = { 'dto/create.dto.ts': dto, 'dto/update.dto.ts': dto };
  const root = writeProject(context, { ...files, 'dto/entry.ts': '', 'dto/parse-json-array.ts': '' });
  assert.equal(buildFix(duplicateFinding(files, 'function parseJsonArray'), createFileCache(root)), undefined);
});
