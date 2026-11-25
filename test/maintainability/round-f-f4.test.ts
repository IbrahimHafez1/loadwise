import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scan } from '../../lib/maintainability/scan.js';
import { defaultLimits } from '../../lib/maintainability/limits.js';
import type { MaintainabilityPolicy } from '../../lib/maintainability/types/policy.js';
import type { FileMap } from '../types/project-files.js';
import type { Finding } from '../../lib/shared/types.js';

const policy: MaintainabilityPolicy = { exclude: [], boundaries: [], placement: [], limits: defaultLimits };

function writeFiles(root: string, files: FileMap) {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
}

// Writes `files` below a fresh folder and scans `scanned` inside it.
async function scanFindings(files: FileMap, scanned = '.') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-round-f4-'));
  try {
    writeFiles(root, files);
    const report = await scan(path.join(root, scanned), policy);
    return report.findings.filter((finding) => /^unused-export$|^unreferenced-file$/.test(finding.ruleId));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const summary = (findings: Finding[]) =>
  findings
    .map((finding: Finding) => `${finding.ruleId} ${finding.file}${finding.contextualReason ? ' (contextual)' : ''}`)
    .sort();

test('a type named in the signature of a used export counts as used', async () => {
  const findings = await scanFindings({
    'package.json': '{"main":"src/index.ts"}',
    'src/index.ts': 'import { load, Repository } from "./repository"; load(); new Repository();',
    'src/repository.ts': [
      'export interface Options { retry: boolean }',
      'export interface Result { id: string }',
      'export interface Row { id: string }',
      'export interface Hidden { id: string }',
      'export interface Orphan { id: string }',
      'export function load(options?: Options): Result { return { id: String(options) }; }',
      'export class Repository { find(): Row[] { return []; } private secret(): Hidden | undefined { return undefined; } }',
      'export function unused(orphan: Orphan) { return orphan; }',
    ].join('\n'),
  });
  assert.deepEqual(findings.map((finding) => finding.exportName).sort(), ['Hidden', 'Orphan', 'unused']);
});

test('a schema composed into an exported DTO class or inferred type counts as used through it', async () => {
  const findings = await scanFindings({
    'package.json': '{"main":"src/index.ts"}',
    'src/index.ts':
      'import { StageDto, Stage } from "./stage.dto"; export const make = (stage: Stage) => new StageDto();',
    'src/stage.dto.ts': [
      'declare const z: any; declare function createZodDto(schema: unknown): new () => object;',
      'export const StageSchema = z.object({});',
      'export const StageListSchema = z.array(StageSchema);',
      'export class StageDto extends createZodDto(StageSchema) {}',
      'export type Stage = z.infer<typeof StageListSchema>;',
    ].join('\n'),
  });
  assert.deepEqual(findings, []);
});

test('an export the module itself uses is reported as a keyword-only, contextual finding', async () => {
  const findings = await scanFindings({
    'package.json': '{"main":"src/index.ts"}',
    'src/index.ts': 'import { run } from "./helpers"; run();',
    'src/helpers.ts': [
      'export const settings = { retries: 3 };',
      'export const dead = 1;',
      'export function run() { return settings.retries; }',
    ].join('\n'),
  });
  const byName = Object.fromEntries(findings.map((finding) => [finding.exportName, finding]));
  assert.deepEqual(Object.keys(byName).sort(), ['dead', 'settings']);
  assert.match(byName.settings.message, /Remove only the `export` keyword/);
  assert.match(byName.settings.contextualReason, /only its export keyword is unused/);
  assert.equal(byName.dead.contextualReason, undefined);
});

test('a dynamic import of a temporary or absolute path does not make the project contextual', async () => {
  for (const loader of [
    'const mainPath = `/tmp/${hash}.mjs`; return import(mainPath);',
    'const mainPath = path.join(os.tmpdir(), hash + ".mjs"); return import(mainPath);',
    'return import(`${os.tmpdir()}/${hash}.mjs`);',
  ]) {
    const findings = await scanFindings({
      'package.json': '{"main":"src/index.ts"}',
      'src/index.ts': `import os from "node:os"; import path from "node:path";\nexport function execute(hash: string) { ${loader} }`,
      'src/orphan.ts': 'export const lonely = 1;',
    });
    assert.deepEqual(summary(findings), ['unreferenced-file src/orphan.ts'], loader);
  }
});

test('a const holding a literal path loads that module; an unknown name still makes findings contextual', async () => {
  const findings = await scanFindings({
    'package.json': '{"main":"src/index.ts"}',
    'src/index.ts': [
      'export function loadPlugin() { const pluginPath = "./plugin"; return import(pluginPath); }',
      'export function loadNamed(name: string) { return import(name); }',
    ].join('\n'),
    'src/plugin.ts': 'export const plugin = 1;',
    'src/orphan.ts': 'export const lonely = 1;',
  });
  assert.deepEqual(summary(findings), ['unreferenced-file src/orphan.ts (contextual)']);
});

test('import.meta.url module URLs, conditional URL paths and tsImport reference their modules', async () => {
  const findings = await scanFindings({
    'package.json': '{"main":"src/index.ts"}',
    'src/index.ts': [
      'export function workerUrl(built: boolean) {',
      '  const entry = built ? "../dist/validate.mjs" : "./cases/validate.mjs";',
      '  return new URL(entry, import.meta.url);',
      '}',
    ].join('\n'),
    'src/cases/validate.mjs':
      'import { tsImport } from "tsx/esm/api";\nawait tsImport("./validate.worker.ts", import.meta.url);',
    'src/cases/validate.worker.ts': 'export const run = () => 1;',
    'src/cases/orphan.ts': 'export const lonely = 1;',
  });
  assert.deepEqual(summary(findings), ['unreferenced-file src/cases/orphan.ts']);
});

test('drizzle schema globs above the scan root and .sequelizerc paths are entry points', async () => {
  const findings = await scanFindings(
    {
      'package.json': '{"private":true}',
      'drizzle.config.ts': 'export default { schema: "./server/db/schema/*.table.ts", out: "./server/db/migrations" };',
      'server/main.ts': 'export {};',
      'server/db/schema/users.table.ts': 'export const users = {};',
      'server/db/schema/helpers.ts': 'export const helper = 1;',
    },
    'server',
  );
  assert.deepEqual(summary(findings), ['unreferenced-file db/schema/helpers.ts']);

  const sequelize = await scanFindings({
    'package.json': '{"main":"src/index.js"}',
    '.sequelizerc': [
      "const path = require('path');",
      "module.exports = { config: path.resolve('src/database/config/config.cjs'), 'models-path': path.resolve('src/database/models') };",
    ].join('\n'),
    'src/index.js': 'module.exports = {};',
    'src/database/config/config.cjs': 'module.exports = { development: {} };',
    'src/database/other.cjs': 'module.exports = {};',
  });
  assert.deepEqual(summary(sequelize), ['unreferenced-file src/database/other.cjs']);
});

test('deep imports by package name from sibling workspace members count as entry points', async () => {
  const findings = await scanFindings(
    {
      'package.json': '{"private":true,"workspaces":["apps/*","packages/*"]}',
      'apps/web/package.json': '{"name":"web"}',
      'apps/web/page.tsx': 'import { AppList } from "@acme/features/apps/components/AppList";\nexport default AppList;',
      'packages/features/package.json': '{"name":"@acme/features"}',
      'packages/features/apps/components/AppList.tsx': 'export const AppList = () => null;',
      'packages/features/apps/components/Unused.tsx': 'export const Unused = () => null;',
    },
    'packages/features',
  );
  assert.deepEqual(summary(findings), ['unreferenced-file apps/components/Unused.tsx']);
});
