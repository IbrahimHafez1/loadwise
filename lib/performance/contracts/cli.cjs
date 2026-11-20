'use strict';

// `loadwise perf contracts ...`: breaking API changes against a git ref. Reads files and git history only.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

const { compareDto, controllerTypeUsages } = require('./dto.cjs');
const { compareGraphql } = require('./graphql.cjs');
const { changedSince, insideNodeModules, listProjectFiles, readAtBase } = require('./git-files.cjs');
const { compareOpenApi } = require('./openapi.cjs');
const { assignFindingIds } = require('../finding-ids.cjs');
const { findingLabel } = require('../finding-text.cjs');
const { findProjectRoot } = require('../schema/context.cjs');

const usage = `Usage:
  loadwise perf contracts [--changed-since <git-ref>] [--json]

Compares the working tree with the merge base of <git-ref> (default HEAD) and flags changes that break API clients:
  OpenAPI/Swagger JSON documents, GraphQL SDL files, and NestJS controller @Body and return classes.
Removed or required-now inputs behind a version bump (a new /v2 next to a kept /v1) are not flagged.
Reads files and git history only; never uses the network.
Exit codes: 0 no breaking changes, 1 breaking changes found, 2 invalid input or configuration.`;

const openApiNames = new Set(['openapi.json', 'swagger.json']);
const yamlOpenApiNames = new Set(['openapi.yaml', 'openapi.yml', 'swagger.yaml', 'swagger.yml']);

function parseOptions(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      'changed-since': { type: 'string', default: 'HEAD' },
      json: { type: 'boolean', default: false },
    },
  });
  if (positionals.length) throw new Error('contracts takes no paths; run it from the project folder.');
  return values;
}

function comparison(context, file, compare) {
  const oldText = readAtBase(context.base, file, context.cwd);
  if (oldText === null) return [];
  try {
    return compare(oldText, fs.readFileSync(path.join(context.cwd, file), 'utf8')).map((finding) => ({
      ...finding,
      file,
    }));
  } catch (error) {
    if (!error.isOperationDocument) console.error(`Skipped ${file}: ${error.message}`);
    return [];
  }
}

function documentFindings(context, file) {
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

function resolveDtoFile(controllerFile, specifier, cwd) {
  if (!specifier?.startsWith('.')) return null;
  const base = path.posix.join(path.posix.dirname(controllerFile), specifier);
  return [`${base}.ts`, `${base}/index.ts`].find((candidate) => fs.existsSync(path.join(cwd, candidate))) ?? null;
}

// The module a relative import names, from the working tree or from the base commit.
function readModule(context, side, fromFile, specifier) {
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

// Syntactic: a ValidationPipe constructed with `forbidNonWhitelisted: true` anywhere in the project (global pipe,
// APP_PIPE provider or @UsePipes), so a removed request property now fails requests that still send it.
function projectForbidsUnknownInput(context, files) {
  const pattern = /new ValidationPipe\(\s*\{[\s\S]{0,600}?forbidNonWhitelisted\s*:\s*true/;
  return files.some((file) => {
    if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) return false;
    const text = fs.readFileSync(path.join(context.cwd, file), 'utf8');
    return text.includes('forbidNonWhitelisted') && pattern.test(text);
  });
}

// A DTO file is worth comparing when it, or a relative module it imports (a base class), changed.
function isOrImportsChanged(context, file) {
  if (context.changed.has(file)) return true;
  const text = fs.readFileSync(path.join(context.cwd, file), 'utf8');
  return [...text.matchAll(/from '(\.[^']*)'/g)].some(({ 1: specifier }) => {
    const imported = resolveDtoFile(file, specifier, context.cwd);
    return imported !== null && context.changed.has(imported);
  });
}

// Each class is judged once per file, with every role (input, output) any controller gives it.
function dtoClassUsages(context, controllerFile) {
  const usages = new Map();
  const text = fs.readFileSync(path.join(context.cwd, controllerFile), 'utf8');
  for (const { name, role, specifier } of controllerTypeUsages(text)) {
    const file = specifier === null ? controllerFile : resolveDtoFile(controllerFile, specifier, context.cwd);
    if (!file || !(context.changed.has(controllerFile) || isOrImportsChanged(context, file))) continue;
    const key = `${file}\0${name}`;
    const usage = usages.get(key) ?? { file, name, roles: new Set() };
    usage.roles.add(role);
    usages.set(key, usage);
  }
  return [...usages.values()];
}

function controllerFindings(context, controllerFiles) {
  const classes = new Map();
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
function describe({ side, ...finding }, ref) {
  const where = side === 'old' ? ` (removed; line ${finding.line} is in the version at ${ref})` : '';
  return { ...finding, message: finding.message + where };
}

function checkContracts({ cwd, ref }) {
  const { base, changed } = changedSince(ref, cwd);
  const context = { cwd, base, changed };
  const files = listProjectFiles(cwd).filter((file) => !insideNodeModules(file));
  const documents = [...changed].filter((file) => !insideNodeModules(file));
  const controllers = files.filter((file) => file.endsWith('.controller.ts'));
  context.forbidsUnknownInput = projectForbidsUnknownInput(context, files);
  const findings = [
    ...documents.flatMap((file) => documentFindings(context, file)),
    ...controllerFindings(context, controllers),
  ];
  const root = findProjectRoot(cwd);
  const located = findings.map((finding) => describe({ ...finding, file: path.join(cwd, finding.file) }, ref));
  const result = assignFindingIds(located, root).map((finding) => ({
    ...finding,
    file: path.relative(cwd, finding.file).split(path.sep).join('/'),
  }));
  return { scannedFiles: documents.length + controllers.length, findings: result };
}

function printText(result) {
  for (const finding of result.findings) {
    const { file, line, column, message } = finding;
    console.log(`${file}:${line}:${column} ${findingLabel(finding)} ${message}`);
  }
  console.log(`${result.scannedFiles} file(s) compared, ${result.findings.length} breaking change(s).`);
}

// Contract with bin: argv is everything after `contracts`; resolves to the exit code (0, 1 or 2).
async function run(argv) {
  try {
    const values = parseOptions(argv);
    if (values.help) {
      console.log(usage);
      return 0;
    }
    const result = checkContracts({ cwd: process.cwd(), ref: values['changed-since'] });
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else printText(result);
    return result.findings.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    return 2;
  }
}

module.exports = { run, usage, checkContracts };
