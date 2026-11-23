'use strict';

// Proves that a fix builder's output still compiles and really removes the finding it was built for.
// `verifyFix` writes a sample project, scans it, applies one fix as `loadwise fix` does, type-checks before and
// after, rescans, and throws an assertion error when the sample does not behave.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { applyFix } = require('../../editor/apply-fix.cjs');
const { analyzeSources, performanceAnalyzers } = require('../../lib/performance/projects.cjs');
const { attachSiteFixes: attachPerformanceFixes } = require('../../lib/performance/site-fix.cjs');
const { attachSiteFixes: attachMaintainabilityFixes } = require('../../lib/maintainability/site-fix.cjs');
const { scan: scanMaintainability } = require('../../lib/maintainability/scan.cjs');
const { applyFix: applyMaintainabilityFix } = require('../../lib/maintainability/apply-fix.cjs');
const { applyBulkFixes } = require('../../lib/shared/fix.cjs');
const { checkRedundantSchemaIndexes } = require('../../lib/performance/redundant-indexes.cjs');
const { checkSchemaFile: checkPrismaSchemaFile } = require('../../lib/performance/schema/prisma-schema.cjs');
const { projectDialect } = require('../../lib/performance/schema/project-indexes.cjs');
const { checkProjectMigrations } = require('../../lib/performance/migrations/cli.cjs');

// Performance rules and security rules share one program run, as the CLI and the editor run them.
const performanceAndSecurityAnalyzers = [
  ...performanceAnalyzers,
  { pillar: 'security', analyzeFile: require('../../lib/security/analyze.cjs').analyzeFile },
];
const maintainabilityPolicy = { exclude: [], boundaries: [], placement: [] };
// Samples read `process.env` without installing Node's types; declaring it keeps the check about the fix only.
const ambientFile = 'loadwise-verification-ambient.d.ts';
const ambientDeclarations = [
  'declare var process: { env: Record<string, string | undefined> };',
  'declare function structuredClone<T>(value: T): T;',
  'declare var console: { log(...values: unknown[]): void; warn(...values: unknown[]): void; error(...values: unknown[]): void };',
  'declare function fetch(input: unknown, init?: object): Promise<unknown>;',
  'declare var AbortSignal: { timeout(milliseconds: number): unknown };',
  'declare function setTimeout(callback: (...values: any[]) => void, milliseconds?: number): unknown;',
  '',
].join('\n');
const sourcePattern = /\.[cm]?[jt]sx?$/;

function writeProject(root, files) {
  for (const [name, contents] of Object.entries({ [ambientFile]: ambientDeclarations, ...files })) {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  }
}

function isScannedSource(name) {
  return sourcePattern.test(name) && !name.endsWith('.d.ts') && !name.split('/').includes('node_modules');
}

// schema.prisma and SQL migrations are outside the TypeScript program; `loadwise perf` adds their index findings after
// the source scan, and so does this.
function schemaFileFindings(root) {
  return [...checkRedundantSchemaIndexes(root, { dialect: projectDialect(root) }), ...checkPrismaSchemaFile(root)];
}

// Migration findings name their file relative to the project; fixes are built and applied from absolute paths.
async function migrationFindings(root) {
  const findings = await checkProjectMigrations({ root });
  return findings.map((finding) => ({ ...finding, file: path.resolve(root, finding.file) }));
}

async function scanSourceFiles({ root, files, policy, migrations }) {
  const sources = Object.keys(files)
    .filter(isScannedSource)
    .map((name) => path.join(root, name));
  const { findings } = analyzeSources({ files: sources, policy, analyzers: performanceAndSecurityAnalyzers });
  findings.push(...schemaFileFindings(root));
  if (migrations) findings.push(...(await migrationFindings(root)));
  attachPerformanceFixes(findings, { comments: false });
  return findings;
}

async function scanProject({ pillar, root, files, policy, migrations }) {
  if (pillar === 'maintainability') {
    const { findings } = await scanMaintainability(root, policy ?? maintainabilityPolicy, { parallelFrom: Infinity });
    attachMaintainabilityFixes(findings, root, { comments: false });
    return findings;
  }
  return scanSourceFiles({ root, files, policy, migrations });
}

function diagnosticKeys(root) {
  const names = [];
  const collect = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (sourcePattern.test(entry.name)) names.push(full);
    }
  };
  collect(root);
  const program = ts.createProgram(names, {
    strict: true,
    noEmit: true,
    // JavaScript samples are only checked for syntax errors.
    allowJs: true,
    checkJs: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    experimentalDecorators: true,
    skipLibCheck: true,
    types: [],
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  });
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const file = diagnostic.file ? path.relative(root, diagnostic.file.fileName) : '';
    return `${file} TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
  });
}

function countBy(items, keyOf) {
  const counts = new Map();
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
  return counts;
}

function newEntries(afterCounts, beforeCounts) {
  return [...afterCounts].filter(([key, count]) => count > (beforeCounts.get(key) ?? 0)).map(([key]) => key);
}

// A sample reported only as a contextual note is counted with its notes; otherwise a finding that stays only as a
// note after the fix counts as removed, because the CLI no longer shows it by default.
function reportedCount(findings, ruleId, { includeContextual }) {
  return findings.filter((finding) => finding.ruleId === ruleId && (includeContextual || !finding.contextualReason))
    .length;
}

function createFileAccess(resolve) {
  return {
    readFile: (file) => fs.readFileSync(resolve(file), 'utf8'),
    writeFile: (file, text) => {
      fs.mkdirSync(path.dirname(resolve(file)), { recursive: true });
      fs.writeFileSync(resolve(file), text);
    },
  };
}

// Maintainability fixes that create a module are written together with their consumers, as `loadwise maint --fix` does.
function applyMaintainabilityFinding(root, finding) {
  if (finding.fix.changes.some((change) => change.create)) {
    const { refused } = applyBulkFixes([finding], root, { includeReview: true });
    return { error: refused[0]?.reason };
  }
  return applyMaintainabilityFix(
    finding.fix,
    createFileAccess((file) => path.resolve(root, file)),
  );
}

function applyFinding(pillar, root, finding) {
  const result =
    pillar === 'maintainability'
      ? applyMaintainabilityFinding(root, finding)
      : applyFix(
          finding.fix,
          createFileAccess((file) => path.resolve(file)),
        );
  assert.equal(result.error, undefined, 'the fix should apply to the scanned text');
}

// The rescan runs on a copy at a new path: the Prisma schema and migration caches are keyed by project root and
// revalidate only every few seconds, so at the same path they could still answer with the text from before the fix.
function copyProject(root) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-fix-verification-rescan-'));
  fs.cpSync(root, copy, { recursive: true });
  return copy;
}

// `pillar` is 'security', 'performance' or 'maintainability'; `files` maps relative names to contents (package
// stubs under node_modules included); `policy` is the optional query or maintainability policy. `migrations: true`
// also runs the migration checks of `loadwise perf migrations`, for samples whose finding is in a migration file.
// Schema and SQL files have no type check: the rescan is their only check, and it reports SQL it cannot parse.
async function verifyFix({ pillar, ruleId, files, policy, migrations }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-fix-verification-'));
  let rescanRoot;
  try {
    writeProject(root, files);
    const findingsBefore = await scanProject({ pillar, root, files, policy, migrations });
    const reported = findingsBefore.filter((finding) => finding.ruleId === ruleId);
    assert.ok(reported.length > 0, `${ruleId} should be reported for the sample`);
    const fixable = reported.find((finding) => finding.fix);
    assert.ok(fixable, `${ruleId} should come with an automatic fix`);
    const diagnosticsBefore = countBy(diagnosticKeys(root), String);
    applyFinding(pillar, root, fixable);
    const newDiagnostics = newEntries(countBy(diagnosticKeys(root), String), diagnosticsBefore);
    assert.deepEqual(newDiagnostics, [], `the fixed ${ruleId} code has new type errors`);
    rescanRoot = copyProject(root);
    const findingsAfter = await scanProject({
      pillar,
      root: rescanRoot,
      files: { ...files, ...changedSources(root, files) },
      policy,
      migrations,
    });
    const rulesBefore = countBy(findingsBefore, (finding) => finding.ruleId);
    const rulesAfter = countBy(findingsAfter, (finding) => finding.ruleId);
    const includeContextual = reportedCount(findingsBefore, ruleId, { includeContextual: false }) === 0;
    const countBefore = reportedCount(findingsBefore, ruleId, { includeContextual });
    const countAfter = reportedCount(findingsAfter, ruleId, { includeContextual });
    assert.ok(
      countAfter < countBefore,
      `${ruleId} is still reported after its fix (${countBefore} before, ${countAfter} after)`,
    );
    assert.deepEqual(newEntries(rulesAfter, rulesBefore), [], `the fix of ${ruleId} introduced other findings`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (rescanRoot) fs.rmSync(rescanRoot, { recursive: true, force: true });
  }
}

// Files a fix created are scanned on the rescan too; the sample's own files are read back from disk.
function changedSources(root, files) {
  const created = {};
  const collect = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) collect(full);
      else {
        const name = path.relative(root, full).split(path.sep).join('/');
        if (!(name in files) && name !== ambientFile) created[name] = '';
      }
    }
  };
  collect(root);
  return created;
}

module.exports = { verifyFix };
