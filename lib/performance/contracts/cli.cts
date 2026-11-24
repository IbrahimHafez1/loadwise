// `loadwise perf contracts ...`: breaking API changes against a git ref. Reads files and git
// history only.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { compareDto, controllerTypeUsages } from './dto.cjs';
import { OperationDocumentError, compareGraphql } from './graphql.cjs';
import { changedSince, insideNodeModules, listProjectFiles, readAtBase } from './git-files.cjs';
import { compareOpenApi } from './openapi.cjs';
import { assignFindingIds } from '../finding-ids.cjs';
import { findingLabel } from '../finding-text.cjs';
import { findProjectRoot } from '../schema/context.cjs';
import { loadSettings } from '../../shared/config.cjs';
import { annotateImpact, filterMinImpact, parseMinImpact } from '../../shared/impact-levels.cjs';
import { impactByRule } from '../rule-ids.cjs';
import { discoverWorkspaces, selectWorkspaces } from '../../shared/workspaces.cjs';
import type { Finding } from '../../shared/types.cjs';
import type {
  ContractCompare,
  ContractFinding,
  ContractRole,
  ContractSide,
  ModuleSource,
} from '../types/contract-findings.cjs';

/** What the comparers need to know about the repository and the run. */
interface ContractContext {
  cwd: string;
  base: string;
  changed: Set<string>;
  includesFile: (file: string) => boolean;
  forbidsUnknownInput: boolean;
}

/**
 * A DTO class a changed controller uses, with every role (input, output) the controllers give it.
 */
interface DtoUsage {
  file: string;
  name: string;
  roles: Set<ContractRole>;
}

interface CheckContractsInput {
  cwd: string;
  ref: string;
  reportRoot?: string;
  includesFile?: (file: string) => boolean;
}

interface ContractsResult {
  scannedFiles: number;
  findings: Finding[];
}

type LoadedSettings = ReturnType<typeof loadSettings>;

const usage = `Usage:
  loadwise perf contracts [--changed-since <git-ref>] [--json] [--min-impact <level>] [--ignore <rule-id>] [--workspace <name|path>] [--loadwise-config <file>]

Compares the working tree with the merge base of <git-ref> (default HEAD) and flags changes that break API clients:
  OpenAPI/Swagger JSON documents, GraphQL SDL files, and NestJS controller @Body and return classes.
Removed or required-now inputs behind a version bump (a new /v2 next to a kept /v1) are not flagged.
Reads files and git history only; never uses the network.
Exit codes: 0 no breaking changes, 1 breaking changes found, 2 invalid input or configuration.`;

const openApiNames = new Set(['openapi.json', 'swagger.json']);
const yamlOpenApiNames = new Set(['openapi.yaml', 'openapi.yml', 'swagger.yaml', 'swagger.yml']);

function parseOptions(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      'changed-since': { type: 'string', default: 'HEAD' },
      json: { type: 'boolean', default: false },
      'min-impact': { type: 'string' },
      'loadwise-config': { type: 'string' },
      ignore: { type: 'string', multiple: true, default: [] },
      workspace: { type: 'string', multiple: true, default: [] },
      // `check` runs this command in the scanned directory but reports paths from its own working
      // directory.
      'report-root': { type: 'string' },
    },
  });
  if (positionals.length) throw new Error('contracts takes no paths; run it from the project folder.');
  return values;
}

function comparison(context: ContractContext, file: string, compare: ContractCompare) {
  const oldText = readAtBase(context.base, file, context.cwd);
  if (oldText === null) return [];
  try {
    return compare(oldText, fs.readFileSync(path.join(context.cwd, file), 'utf8')).map((finding) => ({
      ...finding,
      file,
    }));
  } catch (error) {
    if (!(error instanceof OperationDocumentError)) {
      console.error(`Skipped ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return [];
  }
}

function documentFindings(context: ContractContext, file: string) {
  const name = path.posix.basename(file);
  if (yamlOpenApiNames.has(name)) {
    console.error(
      `Skipped ${file}: YAML OpenAPI documents are not compared (no YAML parser is available). Check a JSON export instead.`,
    );
    return [];
  }
  if (openApiNames.has(name)) return comparison(context, file, compareOpenApi);
  if (/\.(graphql|gql)$/.test(name)) return comparison(context, file, compareGraphql);
  return [];
}

function resolveDtoFile(controllerFile: string, specifier: string | null, cwd: string) {
  if (!specifier?.startsWith('.')) return null;
  const base = path.posix.join(path.posix.dirname(controllerFile), specifier);
  return [`${base}.ts`, `${base}/index.ts`].find((candidate) => fs.existsSync(path.join(cwd, candidate))) ?? null;
}

// The module a relative import names, from the working tree or from the base commit.
function readModule(
  context: ContractContext,
  side: ContractSide,
  fromFile: string,
  specifier: string,
): ModuleSource | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.join(path.posix.dirname(fromFile), specifier);
  for (const file of [`${base}.ts`, `${base}/index.ts`]) {
    const text =
      side === 'old'
        ? readAtBase(context.base, file, context.cwd)
        : fs.existsSync(path.join(context.cwd, file)) && fs.readFileSync(path.join(context.cwd, file), 'utf8');
    if (typeof text === 'string') return { file, text };
  }
  return null;
}

// Syntactic: a ValidationPipe constructed with `forbidNonWhitelisted: true` anywhere in the project
// (global pipe, APP_PIPE provider or @UsePipes), so a removed request property now fails requests
// that still send it.
function projectForbidsUnknownInput(context: ContractContext, files: readonly string[]) {
  const pattern = /new ValidationPipe\(\s*\{[\s\S]{0,600}?forbidNonWhitelisted\s*:\s*true/;
  return files.some((file) => {
    if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) return false;
    const text = fs.readFileSync(path.join(context.cwd, file), 'utf8');
    return text.includes('forbidNonWhitelisted') && pattern.test(text);
  });
}

// A DTO file is worth comparing when it, or a relative module it imports (a base class), changed.
function isOrImportsChanged(context: ContractContext, file: string) {
  if (context.changed.has(file)) return true;
  const text = fs.readFileSync(path.join(context.cwd, file), 'utf8');
  return [...text.matchAll(/\bfrom\s+(['"])(\.[^'"\r\n]*)\1/g)].some(({ 2: specifier }) => {
    const imported = resolveDtoFile(file, specifier, context.cwd);
    return imported !== null && context.changed.has(imported);
  });
}

// Each class is judged once per file, with every role (input, output) any controller gives it.
function dtoClassUsages(context: ContractContext, controllerFile: string) {
  const usages = new Map<string, DtoUsage>();
  const text = fs.readFileSync(path.join(context.cwd, controllerFile), 'utf8');
  for (const { name, role, specifier } of controllerTypeUsages(text)) {
    const file = specifier === null ? controllerFile : resolveDtoFile(controllerFile, specifier, context.cwd);
    if (!file || !context.includesFile(file)) continue;
    if (!(context.changed.has(controllerFile) || isOrImportsChanged(context, file))) continue;
    const key = `${file}\0${name}`;
    const usage = usages.get(key) ?? { file, name, roles: new Set<ContractRole>() };
    usage.roles.add(role);
    usages.set(key, usage);
  }
  return [...usages.values()];
}

function controllerFindings(context: ContractContext, controllerFiles: string[]) {
  const classes = new Map<string, DtoUsage>();
  for (const controllerFile of controllerFiles) {
    for (const usage of dtoClassUsages(context, controllerFile)) {
      const key = `${usage.file}\0${usage.name}`;
      const merged = classes.get(key) ?? usage;
      usage.roles.forEach((role) => merged.roles.add(role));
      classes.set(key, merged);
    }
  }
  return [...classes.values()].flatMap(({ file, name, roles }) =>
    comparison(context, file, (oldText, newText) =>
      compareDto(oldText, newText, name, roles, {
        file,
        forbidsUnknownInput: context.forbidsUnknownInput,
        readModule: (side, fromFile, specifier) => readModule(context, side, fromFile, specifier),
      }),
    ),
  );
}

// `side` says which version the finding's line belongs to; removals point at the base version.
function describe({ side, ...finding }: ContractFinding & { file: string }, ref: string) {
  const where = side === 'old' ? ` (removed; line ${finding.line} is in the version at ${ref})` : '';
  return { ...finding, message: finding.message + where };
}

function checkContracts({
  cwd,
  ref,
  reportRoot = cwd,
  includesFile = () => true,
}: CheckContractsInput): ContractsResult {
  const { base, changed } = changedSince(ref, cwd);
  const context: ContractContext = { cwd, base, changed, includesFile, forbidsUnknownInput: false };
  const inScope = (file: string) => !insideNodeModules(file) && includesFile(file);
  const documents = [...changed].filter(inScope);
  const files = documents.some((file) => file.endsWith('.ts'))
    ? listProjectFiles(cwd).filter(
        (file) => file.endsWith('.ts') && inScope(file) && fs.existsSync(path.join(cwd, file)),
      )
    : [];
  const controllers = files.filter((file) => file.endsWith('.controller.ts'));
  context.forbidsUnknownInput = controllers.length > 0 && projectForbidsUnknownInput(context, files);
  const findings = [
    ...documents.flatMap((file) => documentFindings(context, file)),
    ...controllerFindings(context, controllers),
  ];
  const root = findProjectRoot(cwd);
  const located = findings.map((finding) => describe({ ...finding, file: path.join(cwd, finding.file) }, ref));
  const result = assignFindingIds(located, root).map((finding: Finding) => ({
    ...finding,
    file: path
      .relative(reportRoot, finding.file ?? '')
      .split(path.sep)
      .join('/'),
  }));
  return { scannedFiles: documents.length + controllers.length, findings: result };
}

function contractScope(
  cwd: string,
  reportRoot: string,
  selectors: string[],
  settings: LoadedSettings,
): (file: string) => boolean {
  if (!selectors.length) return (file) => !settings.isIgnored?.(cwd, file);
  const { packages, withoutConfig } = discoverWorkspaces(cwd);
  const selected = selectWorkspaces([...packages, ...withoutConfig], cwd, selectors, reportRoot);
  const prefixes = selected.map(({ directory }) => path.relative(cwd, directory).split(path.sep).join('/') + '/');
  return (file) => prefixes.some((prefix) => file.startsWith(prefix)) && !settings.isIgnored?.(cwd, file);
}

function printText(result: ContractsResult) {
  for (const finding of result.findings) {
    const { file, line, column, message } = finding;
    console.log(`${file}:${line}:${column} ${findingLabel(finding)} ${message}`);
  }
  console.log(`${result.scannedFiles} file(s) compared, ${result.findings.length} breaking change(s).`);
}

// Contract with bin: argv is everything after `contracts`; resolves to the exit code (0, 1 or 2).
async function run(argv: string[]): Promise<number> {
  try {
    const values = parseOptions(argv);
    if (values.help) {
      console.log(usage);
      return 0;
    }
    const cwd = process.cwd();
    const reportRoot = values['report-root'] ?? cwd;
    const settings = loadSettings({ directory: cwd, explicit: values['loadwise-config'], ignore: values.ignore });
    const minImpact = parseMinImpact(values['min-impact']);
    const includesFile = contractScope(cwd, reportRoot, values.workspace, settings);
    const result = checkContracts({ cwd, ref: values['changed-since'], reportRoot, includesFile });
    result.findings = filterMinImpact(
      annotateImpact(settings.apply(result.findings, reportRoot), impactByRule),
      minImpact,
    );
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else {
      printText(result);
      const note = settings.warningNote(result.findings);
      if (note) console.log(note);
    }
    return settings.exitCount(result.findings) ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export { run, usage, checkContracts };
