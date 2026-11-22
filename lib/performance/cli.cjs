'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { impactByRule } = require('./rule-ids.cjs');
const { sourceCheckOptions, validateSourceOptions } = require('./source-options.cjs');
const {
  annotateImpact,
  filterMinImpact,
  parseMinImpact,
  sortByImpactWithinFiles,
} = require('../shared/impact-levels.cjs');
const { loadSettings } = require('../shared/config.cjs');
const {
  applyBaselineOptions,
  baselineForScan,
  baselineNoteLines,
  extractBaselineFlags,
} = require('../shared/baseline.cjs');
const { resolveFormat, renderReports } = require('../shared/formats/index.cjs');
const { contractRules } = require('../shared/formats/contract-rules.cjs');

const usage = `Usage:
  loadwise perf [-p tsconfig.json | -p monorepo-root [--workspace name|path ...] | file.ts file.js ...] [--engine auto|native|js] [--policy policy.json] [--loadwise-config loadwise.config.json] [--schema snapshot.json] [--json | --format text|json|sarif|github] [--include-contextual] [--ignore rule-id] [--min-impact low|medium|high|critical] [--fail-on all|contract] [--baseline [file] | --write-baseline [file]] [--fix [--yes | --only id,...]]
  loadwise perf [-p tsconfig.json] (--staged | --changed-since git-ref) [--json] [--include-contextual] [--ignore rule-id]
  loadwise perf --watch [-p tsconfig.json] [--policy policy.json] [--schema snapshot.json] [--include-contextual] [--ignore rule-id]
  loadwise perf contracts [--changed-since git-ref] [--json]
  loadwise perf migrations [paths...] [--changed-since git-ref] [--baseline file] [--write-baseline] [--dialect postgres|mysql] [--json] [--include-contextual] [--ignore rule-id]
  loadwise perf db [--url-env DATABASE_URL] [--env-file .env] [--engine postgres|mysql|mongo] [--schema-snapshot out.json] [--top 20] [--queries file.sql] [--analyze] [--measure --i-understand-this-locks-tables] [--runs 5] [--json] [--ignore rule-id]
  loadwise perf traces trace.json [--threshold 5] [--json]
  loadwise perf plan explain.json [--json]
  loadwise perf polyglot <file-or-directory> ... [--json]
  loadwise perf editor init
  loadwise perf editor watch [-p tsconfig.json]
  loadwise perf agent init [--mode ask|auto] [--hook [block|warn|off]]

With no arguments, check tsconfig.json or jsconfig.json in the current directory.
In a monorepo root without one, every workspace package (package.json "workspaces", pnpm-workspace.yaml or lerna.json) with its own tsconfig.json or jsconfig.json is checked in one report; --workspace limits it to the named packages or folders.
Source checks look for backend-perf.policy.json beside the selected config, or in the working directory for explicit files.
A loadwise.config.json there also applies: its "performance" section replaces backend-perf.policy.json, and its ignore, rules and overrides filter the findings; --loadwise-config names another file.
--fix shows each available code fix and asks before applying it; --fix --yes applies eligible fixes without asking.
--fix --only id1,id2 applies exactly those findings' fixes without asking; with --json it prints { applied, alreadyApplied, failed }.
Every finding has a stable id (shown as #id); a failed --only id exits 2.
--write-baseline records the current findings in loadwise-baseline.json (or the given file); --baseline hides them so only new findings are reported and reports how many were hidden.
The baseline file has one section per checker, shared with loadwise maint and loadwise check; entries are matched by rule, file and flagged code, not line number.
--staged and --changed-since report only findings on lines changed in the git index or since a ref, with a fix and a dismiss command per finding.
agent init writes one block of instructions for AI coding agents, covering all three checkers, into AGENTS.md and imports it from CLAUDE.md.
agent init --hook installs one git pre-commit hook that runs \`loadwise check --staged\`: block fails the commit on findings, warn only prints them, off removes the hook. --hook alone means warn.
Source checks summarize contextual findings. --include-contextual includes their locations and review reasons.
Source checks use the TypeScript 7 native compiler when it is installed and accepts the project, otherwise TypeScript 6.
--engine native requires TypeScript 7 (--native is an alias). --engine js always uses TypeScript 6.
--fail-on contract exits 1 only for pg-transaction-on-pool.
--min-impact reports only findings at that impact level or above; the rest do not count toward the exit code.
--format sarif and github print the findings for GitHub code scanning and workflow annotations; --json is --format json.
--schema reads a snapshot written by db --schema-snapshot; it refines index checks with table sizes and measured round trips.
Only the db command connects to a database. Every other command works from files alone.
The traces command reads one OTLP/JSON export. Its threshold counts sibling DB spans.
Exit codes: 0 passed, 1 findings meeting the exit threshold, 2 invalid input or configuration.`;

function readJsonFile(filename, label) {
  const raw = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(label + ' file contains invalid JSON.');
  }
}

function parseCommand(args, options) {
  return parseArgs({ args, allowPositionals: true, options: { help: { type: 'boolean', short: 'h' }, ...options } });
}

function showHelp() {
  console.log(usage);
  return 0;
}

function checkPlan(args) {
  const { values, positionals } = parseCommand(args, { json: { type: 'boolean' } });
  if (values.help) return showHelp();
  if (positionals.length !== 1) throw new Error('Pass exactly one executed query plan to plan.');
  const { inspectPlan } = require('./plans.cjs');
  const result = inspectPlan(readJsonFile(positionals[0], 'Plan'));
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const { path, ruleId, message, ...metrics } of result.findings) {
      console.log(`${path} [${ruleId}] ${message} ${JSON.stringify(metrics)}`);
    }
    console.log(`${result.engine} execution plan, ${result.findings.length} finding(s).`);
  }
  return result.findings.length ? 1 : 0;
}

function checkTraces(args) {
  const { values, positionals } = parseCommand(args, {
    json: { type: 'boolean' },
    threshold: { type: 'string', default: '5' },
  });
  if (values.help) return showHelp();
  if (positionals.length !== 1) throw new Error('Pass exactly one OTLP JSON file to traces.');
  const threshold = Number(values.threshold);
  if (!/^\d+$/.test(values.threshold) || !Number.isSafeInteger(threshold) || threshold < 2) {
    throw new Error('--threshold must be an integer of at least 2.');
  }
  const document = readJsonFile(positionals[0], 'Trace');
  const { inspectTraces } = require('./traces.cjs');
  const { formatImpact } = require('./impact.cjs');
  const result = inspectTraces(document, { threshold });
  const { findings, scannedSpans, eligibleDbSpans } = result;
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const finding of findings) {
      console.log(
        `${finding.traceId} parent ${finding.parentSpanId || '(root)'} [${finding.ruleId}] ${finding.message}`,
      );
      const impact = formatImpact(finding.impact);
      if (impact) console.log(`  ${impact}`);
    }
    console.log(
      `${eligibleDbSpans} distinct eligible DB span(s) across ${scannedSpans} input span(s), ${findings.length} finding(s).`,
    );
  }
  return findings.length ? 1 : 0;
}

// The folder holding backend-perf.policy.json and loadwise.config.json: the project, or the working directory for files.
function projectDirectory(config, files) {
  const { resolveConfig } = require('./source-inputs.cjs');
  return files.length ? process.cwd() : path.dirname(resolveConfig(config ?? '.'));
}

// The "performance" section of loadwise.config.json holds the same policy as backend-perf.policy.json.
function configPolicySource(settings) {
  const { loadConfig } = require('../shared/config.cjs');
  return {
    filename: settings.filename,
    read() {
      try {
        const { validateQueryPolicy } = require('./query-policy.cjs');
        return validateQueryPolicy(loadConfig({ explicit: settings.filename }).config.performance);
      } catch (error) {
        throw new Error('Cannot load the "performance" section of ' + settings.filename + ': ' + error.message);
      }
    },
  };
}

function sourcePolicy(explicit, directory, settings) {
  const filename = explicit !== undefined ? path.resolve(explicit) : path.join(directory, 'backend-perf.policy.json');
  if (explicit === undefined && settings.performance) {
    if (fs.existsSync(filename)) {
      console.error(`Note: ${settings.filename} has a "performance" section; ignoring ${filename}.`);
    }
    return configPolicySource(settings);
  }
  let required = explicit !== undefined;
  return {
    filename,
    read() {
      try {
        const policy = require('./query-policy.cjs').loadQueryPolicy(filename);
        required = true;
        return policy;
      } catch (error) {
        if (error.code === 'ENOENT' && !required) return;
        // Once discovered, a broken or removed policy must not silently disable enforcement in watch mode.
        required = true;
        throw new Error('Cannot load query policy ' + filename + ': ' + error.message);
      }
    },
  };
}

// A directory without its own config, or an explicit --workspace, means a monorepo: one config per package.
function workspaceTarget(values, positionals) {
  const directory = path.resolve(values.project ?? '.');
  const isDirectory = fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory();
  if (positionals.length || !isDirectory) {
    if (values.workspace.length) throw new Error('--workspace needs a monorepo directory.');
    return undefined;
  }
  const { discoverWorkspaces, projectConfig, selectWorkspaces } = require('../shared/workspaces.cjs');
  if (!values.workspace.length && projectConfig(directory)) return undefined;
  const { packages, withoutConfig } = discoverWorkspaces(directory);
  if (!packages.length) {
    if (values.workspace.length)
      throw new Error('--workspace found no workspace package with a tsconfig.json or jsconfig.json.');
    return undefined;
  }
  for (const { name } of withoutConfig) {
    console.error(`Note: workspace ${name} has no tsconfig.json or jsconfig.json; skipped it.`);
  }
  const chosen = selectWorkspaces(packages, directory, values.workspace);
  return {
    directory,
    configs: chosen.map(({ config }) => config),
    packages: chosen.map(({ name, directory: packageDirectory }) => ({
      name,
      directory: relativeToCwd(packageDirectory),
    })),
  };
}

function relativeToCwd(target) {
  return path.relative(process.cwd(), target).split(path.sep).join('/') || '.';
}

async function checkCode(args, report = printResult, baselineFlags = {}) {
  const { values, positionals } = parseCommand(args, sourceCheckOptions);
  if (values.help) return showHelp();
  const baselineOptions = baselineForScan(
    baselineFlags,
    values,
    positionals.map((file) => path.resolve(file)),
  );
  const { engine, onlyIds } = validateSourceOptions(values, positionals, baselineOptions);
  const scope = readChangedScope(values, positionals);
  if (scope && !scope.changedLines.size && !values.online) {
    printEmptyChangedReport(values);
    return 0;
  }
  await loadSqlParser();
  loadSchemaSnapshot(values.schema);
  const workspace = workspaceTarget(values, positionals);
  if (workspace && values.watch) throw new Error('--watch needs one project config, not a monorepo.');
  // The folder that names the project in ids, the policy lookup and the printed fix command.
  const project = workspace ? relativeToCwd(workspace.directory) : values.project;
  // Node reuses bytecode for the compiler across invocations. Each run still reads the current project.
  require('node:module').enableCompileCache?.();
  // A monorepo root keeps its policy and config at the root, beside no project config.
  const input = path.resolve(values.project ?? '.');
  const inferredFiles =
    !workspace && !positionals.length && !values.watch
      ? require('../shared/workspaces.cjs').plainJavaScriptSources(input)
      : undefined;
  const directory = workspace?.directory ?? (inferredFiles ? input : projectDirectory(values.project, positionals));
  // CLI --ignore ids are filtered by selectFindings, so the settings only add the config's own filters.
  values.settings = loadSettings({ directory, explicit: values['loadwise-config'] });
  // The default baseline file sits in the same folder.
  values.projectDirectory = directory;
  const policySource = sourcePolicy(values.policy, directory, values.settings);
  const policy = policySource.read();
  if (values.with !== undefined)
    return checkWithSecurity({
      values,
      positionals,
      policy,
      scope,
      workspace,
      project,
      baselineOptions,
      inferredFiles,
    });
  if (values.watch) {
    const { watchProject } = require('./watch.cjs');
    watchProject(values.project ?? '.', {
      policySource,
      onResult(result) {
        appendPrismaSchemaFindings(result, [values.project ?? '.']);
        printResult(result, values);
      },
      onError(error) {
        console.error(error.message ?? error);
      },
    });
    return 0;
  }
  // The editor watcher checks repeatedly in one process, which keeps it on the JS compiler. It shows the security
  // findings too, from the same Program.
  const editorAnalyzers = report !== printResult && [
    ...require('./projects.cjs').performanceAnalyzers,
    require('../security/cli.cjs').analyzer,
  ];
  const { result, usedFallback } = analyzeSourceCode(
    {
      project: workspace?.configs ?? values.project,
      files: inferredFiles ?? positionals,
      policy,
      onlyFiles: scanFilter(values.settings, scope),
      ...(editorAnalyzers && { analyzers: editorAnalyzers }),
    },
    report === printResult ? engine : 'js',
  );
  if (workspace?.packages.length > 1) result.packages = workspace.packages;
  // TypeScript rejects a project with no inputs, but one emptied by ignore globs scans nothing without complaint.
  if (!scope && values.settings.isIgnored && result.scannedFiles === 0) {
    console.error(
      `Note: every source file matches "ignore" in ${values.settings.filename}; no files were left to check.`,
    );
  }
  if (!positionals.length) appendPrismaSchemaFindings(result, workspace?.configs ?? [project ?? '.'], scope);
  if (values.fix && report === printResult) return applySourceFixes(result, values, onlyIds, project, positionals);
  const reportValues = {
    ...values,
    project,
    baselineOptions,
    fixCommand: require('../shared/source-report.cjs').fixAllCommand(
      'perf',
      project,
      positionals,
      usedFallback ? { ...values, engine: 'js' } : values,
    ),
  };
  const code = report(result, scope ? { ...reportValues, changedLines: scope.changedLines } : reportValues);
  if (report === printResult) require('./notify-editor.cjs').notifyEditor(values.project ?? process.cwd());
  return code;
}

function applySourceFixes(result, values, onlyIds, project, files) {
  assignFindingIds(result.findings, findingRoot(project));
  const historyProject = require('../shared/fix-history.cjs').sourceHistoryProject(values.projectDirectory, files);
  // Named ids are explicit, so they reach contextual and ignored findings too.
  if (onlyIds.length) {
    return require('./fix-cli.cjs').applyChosenFixes(result.findings, onlyIds, {
      json: resolveFormat(values) === 'json',
      project: historyProject,
    });
  }
  // --fix offers exactly the findings the report would show, so --min-impact narrows it too.
  selectFindings(result, values);
  result.findings = filterMinImpact(annotateImpact(result.findings, impactByRule), values['min-impact']);
  return require('./fix-cli.cjs').applyFixes(result.findings, { all: values.yes, project: historyProject });
}

// Ids hash paths relative to the project root, so they match whichever folder the check runs from.
function findingRoot(project) {
  return require('./schema/context.cjs').findProjectRoot(path.resolve(project ?? '.'));
}

function assignFindingIds(findings, root) {
  require('./finding-ids.cjs').assignFindingIds(findings, root);
}

// `check` runs perf and sec together through `--with sec`, so the project is type-checked once on the JS compiler.
// Prints { performance: { code, stdout }, security: { code, stdout } } for the parent to split.
async function checkWithSecurity({
  values,
  positionals,
  policy,
  scope,
  workspace,
  project,
  baselineOptions,
  inferredFiles,
}) {
  const { analyzeSources, performanceAnalyzers } = require('./projects.cjs');
  const sourceReport = require('../shared/source-report.cjs');
  const performancePillar = { command: 'perf' };
  const security = require('../security/cli.cjs');
  const result = analyzeSources({
    project: workspace?.configs ?? values.project,
    files: inferredFiles ?? positionals,
    policy,
    onlyFiles: scanFilter(values.settings, scope),
    analyzers: [...performanceAnalyzers, security.analyzer],
  });
  if (!positionals.length) appendPrismaSchemaFindings(result, workspace?.configs ?? [project ?? '.'], scope);
  if (workspace) result.packages = workspace.packages;
  const fileFindings = security.scanFiles(values, positionals, workspace, scope?.isChangedFile).findings;
  let dependencies;
  let dependencyError;
  if (values.online) {
    try {
      dependencies = await require('../security/deps/scan.cjs').scanDependencies(values.projectDirectory);
    } catch (error) {
      dependencyError = error;
    }
  } else if (!scope) {
    require('../security/deps/cli.cjs').noteOffline(values.projectDirectory);
  }
  const reports = {};
  for (const [jsonKey, pillar] of [
    ['performance', performancePillar],
    ['security', security.pillar],
  ]) {
    const isSecurity = jsonKey === 'security';
    if (isSecurity && dependencyError) {
      console.error(dependencyError.message);
      reports.security = { code: 2, stdout: '' };
      continue;
    }
    const findings = result.findings.filter((finding) => (finding.pillar ?? 'performance') === jsonKey);
    for (const finding of findings) delete finding.pillar;
    if (isSecurity) findings.push(...fileFindings, ...(dependencies?.findings ?? []));
    const reportResult = { ...result, findings };
    if (isSecurity && dependencies) {
      reportResult.scannedFiles += dependencies.scannedFiles;
      reportResult.scannedPackages = dependencies.scannedPackages;
    }
    const pillarValues = {
      ...values,
      project,
      baselineOptions,
      fixCommand: sourceReport.fixAllCommand(pillar.command, project, positionals, values),
      ...(scope && { changedLines: scope.changedLines }),
    };
    const lines = [];
    const print = (line) => lines.push(line);
    const code =
      jsonKey === 'performance'
        ? printResult(reportResult, pillarValues, print)
        : sourceReport.printResult(reportResult, pillarValues, pillar, print);
    reports[jsonKey] = { code, stdout: lines.map((line) => line + '\n').join('') };
  }
  console.log(JSON.stringify(reports));
  require('./notify-editor.cjs').notifyEditor(values.project ?? process.cwd());
  return Math.max(reports.performance.code, reports.security.code);
}

// schema.prisma is not TypeScript, so its foreign-key findings come from the parsed schema after the scan.
function appendPrismaSchemaFindings(result, projects, scope) {
  if (scope && ![...scope.changedLines.keys()].some((file) => file.endsWith('.prisma'))) return;
  const { findProjectRoot } = require('./schema/context.cjs');
  const { checkSchemaFile, findPrismaSchemaFiles } = require('./schema/prisma-schema.cjs');
  const roots = new Set(projects.map((project) => findProjectRoot(path.resolve(project))));
  for (const root of roots) {
    if (!scope || findPrismaSchemaFiles(root).some(scope.isChangedFile)) result.findings.push(...checkSchemaFile(root));
  }
}

// The snapshot is optional; without it every rule still reports, using unknown-size wording.
function loadSchemaSnapshot(filename) {
  const { loadSnapshot, useSnapshot } = require('./schema/context.cjs');
  useSnapshot(filename === undefined ? undefined : loadSnapshot(path.resolve(filename)));
}

// Only the first sentence: the full TypeScript 7 diagnostic list repeats itself and buries the findings.
function firstReason(reason) {
  return reason.split(/(?<=\.)\s+/)[0].replace(/\.$/, '');
}

// Loading the JS engine binds the shared rules to TypeScript 6, so it is required only once native is ruled out.
function analyzeSourceCode(options, engine) {
  const analyzeSources = (sourceOptions) => require('./projects.cjs').analyzeSources(sourceOptions);
  if (engine === 'js') return { result: analyzeSources(options) };
  const result = require('./native.cjs').analyzeNative({ ...options, fallback: engine === 'auto' });
  if (!result.fallback) return { result };
  const fallbackResult = analyzeSources(options);
  if (result.reason) {
    const { version } = require('typescript');
    console.error(
      `Note: TypeScript 7 cannot load this project (${firstReason(result.reason)}); used TypeScript ${version}.`,
    );
  }
  return { result: fallbackResult, usedFallback: true };
}

// Ignored files are never scanned, so they cost no time and add nothing to the file count.
function scanFilter(settings, scope) {
  if (!settings.isIgnored) return scope?.isChangedFile;
  return (filename) => !settings.isIgnored(process.cwd(), filename) && (scope?.isChangedFile(filename) ?? true);
}

function selectFindings(result, values) {
  if (values.settings) result.findings = values.settings.apply(result.findings, process.cwd());
  result.findings = result.findings.filter((finding) => !values.ignore.includes(finding.ruleId));
  if (values['include-contextual'] !== undefined) {
    const classifyTestWrite = require('./review-context.cjs').createTestWriteClassifier();
    let contextualCount = 0;
    result.findings = result.findings.filter((finding) => {
      const reason = finding.contextualReason || classifyTestWrite(finding.file, finding.ruleId);
      if (!reason) return true;
      finding.contextualReason = reason;
      contextualCount++;
      return values['include-contextual'];
    });
    if (contextualCount) result.contextualFindingCount = contextualCount;
  }
  return result.findings;
}

function isContractFinding({ ruleId }) {
  return contractRules.performance.has(ruleId);
}

function printResult(result, values, print = console.log) {
  // Ids are assigned before filtering, so collision suffixes do not depend on which findings are shown.
  const idRoot = findingRoot(values.project);
  assignFindingIds(result.findings, idRoot);
  selectFindings(result, values);
  result.findings = sortByImpactWithinFiles(
    filterMinImpact(annotateImpact(result.findings, impactByRule), values['min-impact']),
  );
  if (values.changedLines) {
    result.findings = require('./changed-lines.cjs').keepChangedFindings(result.findings, values.changedLines);
  }
  const baseline = applyBaselineOptions({
    options: values.baselineOptions ?? {},
    pillar: 'performance',
    findings: result.findings,
    projectRoot: values.projectDirectory,
    absoluteFileOf: (finding) => path.resolve(finding.file),
    idRoot,
  });
  if (baseline?.written !== undefined) {
    const message = `Wrote ${baseline.written} finding(s) to ${path.relative(process.cwd(), baseline.file) || baseline.file}.`;
    (resolveFormat(values) === 'text' ? print : console.error)(message);
    return 0;
  }
  if (baseline) {
    result.findings = baseline.findings;
    result.baselineHidden = baseline.hidden;
    result.baselineStale = baseline.stale;
  }
  const contractOnly = values['fail-on'] === 'contract';
  if (contractOnly) {
    result.contractFindingCount = result.findings.filter(isContractFinding).length;
  }
  const { attachExample } = require('./finding-text.cjs');
  require('./site-fix.cjs').attachSiteFixes(result.findings);
  for (const finding of result.findings) {
    finding.fixable = Boolean(finding.fix);
    attachExample(finding);
  }
  printSourceOutput(result, values, baseline, print);
  return values.settings.exitCount(result.findings, contractOnly ? isContractFinding : undefined) ? 1 : 0;
}

function printSourceOutput(result, values, baseline, print) {
  const { printChangedFindings, printFullReport } = require('./source-text.cjs');
  const format = resolveFormat(values);
  if (format === 'json') print(JSON.stringify(result, null, values.watch ? 0 : 2));
  else if (format !== 'text') printStructured(format, result, values.projectDirectory, print);
  else if (values.changedLines) {
    printChangedFindings(result.findings, values.fixCommand, print);
    if (baseline) for (const line of baselineNoteLines(baseline)) print(line);
  } else {
    printFullReport(result, values, baseline, print);
  }
  const warningNote = values.settings.warningNote(result.findings);
  if (warningNote && format === 'text' && !values.changedLines) print(warningNote);
}

// Finding paths are relative to the working directory.
function printStructured(format, result, repositoryDirectory, print) {
  const output = renderReports(format, [
    { pillar: 'performance', root: process.cwd(), repositoryDirectory, report: result },
  ]);
  if (output) print(output);
}

// Reads only the two scope flags, so an empty change set can exit before TypeScript or the SQL parser loads.
function readChangedScope(values, positionals) {
  if (values.help || (!values.staged && values['changed-since'] === undefined)) return undefined;
  if (values.staged && values['changed-since'] !== undefined) {
    throw new Error('Choose either --staged or --changed-since.');
  }
  if (positionals.length || values.watch || values.fix) {
    throw new Error('--staged and --changed-since cannot be combined with explicit files, --watch or --fix.');
  }
  const { collectProjectChangedLines, fileKey } = require('./changed-lines.cjs');
  // `check` runs the security checker too, which also reads env, Dockerfile and compose files.
  const allFiles = values.with !== undefined;
  const changedLines = collectProjectChangedLines(
    { staged: values.staged, ref: values['changed-since'], allFiles },
    values.project,
  );
  return { changedLines, isChangedFile: (filename) => changedLines.has(fileKey(filename)) };
}

async function runEditor(args) {
  if (args[0] === 'init' && args.length === 1) {
    const setup = require('./editor-setup.cjs').setupEditor(process.cwd());
    console.log((setup.changed ? 'Configured ' : 'Already configured: ') + setup.filename);
    console.log(
      'Open or reopen the trusted folder in VS Code or Cursor and allow automatic tasks once. Terminal source scans refresh the active watcher.',
    );
    return 0;
  }
  if (args[0] !== 'watch') throw new Error('Usage: loadwise perf editor init  |  editor watch [-p tsconfig.json]');
  const { values, positionals } = parseCommand(args.slice(1), { project: { type: 'string', short: 'p' } });
  if (values.help) return showHelp();
  if (positionals.length) throw new Error('editor watch accepts only an optional -p project config.');
  await loadSqlParser();
  require('./editor-watch.cjs').watchEditor(process.cwd(), values.project, (inputs) =>
    checkCode(inputs, selectFindings),
  );
  return 0;
}

async function runPolyglot(args) {
  const { values, positionals } = parseCommand(args, {
    json: { type: 'boolean' },
    'min-impact': { type: 'string' },
    'loadwise-config': { type: 'string' },
  });
  if (values.help) return showHelp();
  parseMinImpact(values['min-impact']);
  if (!positionals.length) throw new Error('Pass at least one file or directory to polyglot.');
  const { checkPolyglot } = require('./polyglot.cjs');
  const result = await checkPolyglot(positionals);
  const settings = loadSettings({ directory: process.cwd(), explicit: values['loadwise-config'] });
  const code = printResult(result, { ...values, ignore: [], settings });
  require('./notify-editor.cjs').notifyEditor(positionals.length === 1 ? positionals[0] : process.cwd());
  return code;
}

async function main(args) {
  // Resolve subcommand dependencies only after selecting the command.
  switch (args[0]) {
    case 'editor':
      return runEditor(args.slice(1));
    case 'agent':
      return require('../shared/agent-init.cjs').runAgentCommand(args.slice(1));
    case 'migrations':
      return require('./migrations/cli.cjs').run(args.slice(1));
    case 'contracts':
      return require('./contracts/cli.cjs').run(args.slice(1));
    case 'db':
      return require('./db/cli.cjs').run(args.slice(1));
    case 'traces':
      return checkTraces(args.slice(1));
    case 'plan':
      return checkPlan(args.slice(1));
    case 'polyglot':
      return runPolyglot(args.slice(1));
  }
  const { args: sourceArgs, ...baselineOptions } = extractBaselineFlags(args);
  return checkCode(sourceArgs, printResult, baselineOptions);
}

function printEmptyChangedReport(values) {
  const result = { scannedFiles: 0, findings: [] };
  const format = resolveFormat(values);
  function output(pillar) {
    if (format === 'json') return JSON.stringify(result);
    if (format === 'text') return 'No changed files to check.';
    return renderReports(format, [{ pillar, root: process.cwd(), report: result }]);
  }
  if (values.with === 'sec') {
    const reports = {};
    for (const pillar of ['performance', 'security']) {
      const rendered = output(pillar);
      reports[pillar] = { code: 0, stdout: rendered ? rendered + '\n' : '' };
    }
    console.log(JSON.stringify(reports));
  } else {
    const rendered = output('performance');
    if (rendered) console.log(rendered);
  }
}

// Raw SQL index rules parse synchronously during the scan, and the WASM parser can only load asynchronously.
function loadSqlParser() {
  return require('./sql/pg-parser.cjs').ensureLoaded();
}

module.exports = { main, sourcePolicy, workspaceTarget, projectDirectory, scanFilter, relativeToCwd };
