'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { knownRules } = require('./rule-ids.cjs');

const usage = `Usage:
  warden-backend [-p tsconfig.json | file.ts file.js ...] [--engine auto|native|js] [--policy policy.json] [--schema snapshot.json] [--json] [--include-contextual] [--ignore rule-id] [--fail-on all|contract] [--fix [--yes | --only id,...]]
  warden-backend [-p tsconfig.json] (--staged | --changed-since git-ref) [--json] [--include-contextual] [--ignore rule-id]
  warden-backend --watch [-p tsconfig.json] [--policy policy.json] [--schema snapshot.json] [--include-contextual] [--ignore rule-id]
  warden-backend migrations [paths...] [--changed-since git-ref] [--baseline file] [--write-baseline] [--dialect postgres|mysql] [--json] [--include-contextual] [--ignore rule-id]
  warden-backend db [--url-env DATABASE_URL] [--env-file .env] [--engine postgres|mysql|mongo] [--schema-snapshot out.json] [--top 20] [--queries file.sql] [--analyze] [--measure --i-understand-this-locks-tables] [--runs 5] [--json] [--ignore rule-id]
  warden-backend traces trace.json [--threshold 5] [--json]
  warden-backend plan explain.json [--json]
  warden-backend polyglot <file-or-directory> ... [--json]
  warden-backend editor init
  warden-backend editor watch [-p tsconfig.json]
  warden-backend agent init [--mode ask|auto] [--hook [block|warn|off]]

With no arguments, check tsconfig.json or jsconfig.json in the current directory.
Source checks look for backend-perf.policy.json beside the selected config, or in the working directory for explicit files.
--fix shows each available code fix and asks before applying it; --fix --yes applies every one without asking.
--fix --only id1,id2 applies exactly those findings' fixes without asking; with --json it prints { applied, alreadyApplied, failed }.
Every finding has a stable id (shown as #id); a failed --only id exits 2.
--staged and --changed-since report only findings on lines changed in the git index or since a ref, with a fix and a dismiss command per finding.
agent init writes one block of instructions for AI coding agents, covering both checkers, into AGENTS.md and imports it from CLAUDE.md.
agent init --hook installs one git pre-commit hook that runs \`loadwise check --staged\`: block fails the commit on findings, warn only prints them, off removes the hook. --hook alone means warn.
Source checks summarize contextual findings. --include-contextual includes their locations and review reasons.
Source checks use the TypeScript 7 native compiler when it is installed and accepts the project, otherwise TypeScript 6.
--engine native requires TypeScript 7 (--native is an alias). --engine js always uses TypeScript 6.
--fail-on contract exits 1 only for pg-transaction-on-pool.
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

function sourcePolicy(explicit, config, files) {
  const { resolveConfig } = require('./source-inputs.cjs');
  const filename =
    explicit !== undefined
      ? path.resolve(explicit)
      : path.join(
          files.length ? process.cwd() : path.dirname(resolveConfig(config ?? '.')),
          'backend-perf.policy.json',
        );
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

const sourceCheckOptions = {
  project: { type: 'string', short: 'p' },
  policy: { type: 'string' },
  'fail-on': { type: 'string', default: 'all' },
  'include-contextual': { type: 'boolean', default: false },
  json: { type: 'boolean' },
  watch: { type: 'boolean' },
  native: { type: 'boolean' },
  engine: { type: 'string' },
  ignore: { type: 'string', multiple: true, default: [] },
  schema: { type: 'string' },
  fix: { type: 'boolean' },
  yes: { type: 'boolean' },
  only: { type: 'string', multiple: true, default: [] },
  staged: { type: 'boolean' },
  'changed-since': { type: 'string' },
};

function checkCode(args, report = printResult, scope) {
  const { values, positionals } = parseCommand(args, sourceCheckOptions);
  if (values.help) return showHelp();
  if (values.project && positionals.length) throw new Error('Choose either a project or explicit source files.');
  if (!['all', 'contract'].includes(values['fail-on'])) throw new Error('--fail-on must be all or contract.');
  if (values.native && (values.engine ?? 'native') !== 'native')
    throw new Error('--native is an alias for --engine native.');
  const engine = values.native ? 'native' : (values.engine ?? 'auto');
  if (!['auto', 'native', 'js'].includes(engine)) throw new Error('--engine must be auto, native or js.');
  if (values.watch && engine === 'native')
    throw new Error('--native supports one-shot checks. Use --watch with the incremental JS compiler.');
  if (values.watch && positionals.length) throw new Error('--watch requires a project config.');
  const onlyIds = values.only
    .flatMap((list) => list.split(','))
    .map((id) => id.trim())
    .filter(Boolean);
  if (values.only.length && !values.fix) throw new Error('--only is only valid with --fix.');
  if (values.only.length && !onlyIds.length) throw new Error('--only needs at least one finding id.');
  if (values.fix && values.watch) throw new Error('--fix cannot be combined with --watch.');
  if (values.fix && values.json && !onlyIds.length)
    throw new Error('--fix prints a report with --json only with --only.');
  if (values.yes && !values.fix) throw new Error('--yes is only valid with --fix.');
  for (const ruleId of values.ignore) {
    if (!knownRules.has(ruleId)) throw new Error('Unknown source rule: ' + ruleId);
  }
  loadSchemaSnapshot(values.schema);
  // Node reuses bytecode for the compiler across invocations. Each run still reads the current project.
  require('node:module').enableCompileCache?.();
  const policySource = sourcePolicy(values.policy, values.project, positionals);
  const policy = policySource.read();
  if (values.watch) {
    const { watchProject } = require('./watch.cjs');
    watchProject(values.project ?? '.', {
      policySource,
      onResult(result) {
        appendPrismaSchemaFindings(result, values.project ?? '.');
        printResult(result, values);
      },
      onError(error) {
        console.error(error.message ?? error);
      },
    });
    return 0;
  }
  // The editor watcher checks repeatedly in one process, which keeps it on the JS compiler.
  const result = analyzeSourceCode(
    { project: values.project, files: positionals, policy, onlyFiles: scope?.isChangedFile },
    report === printResult ? engine : 'js',
  );
  if (values.project && !scope) appendPrismaSchemaFindings(result, values.project);
  if (values.fix && report === printResult) {
    assignFindingIds(result.findings, findingRoot(values.project));
    // Named ids are explicit, so they reach contextual and ignored findings too.
    if (onlyIds.length) {
      return require('./fix-cli.cjs').applyChosenFixes(result.findings, onlyIds, {
        json: values.json,
      });
    }
    selectFindings(result, values);
    return require('./fix-cli.cjs').applyFixes(result.findings, { all: values.yes });
  }
  const code = report(result, scope ? { ...values, changedLines: scope.changedLines } : values);
  if (report === printResult) require('./notify-editor.cjs').notifyEditor(values.project ?? process.cwd());
  return code;
}

// Ids hash paths relative to the project root, so they match whichever folder the check runs from.
function findingRoot(project) {
  return require('./schema/context.cjs').findProjectRoot(path.resolve(project ?? '.'));
}

function assignFindingIds(findings, root) {
  require('./finding-ids.cjs').assignFindingIds(findings, root);
}

// schema.prisma is not TypeScript, so its foreign-key findings come from the parsed schema after the scan.
function appendPrismaSchemaFindings(result, project) {
  const { findProjectRoot } = require('./schema/context.cjs');
  const root = findProjectRoot(path.resolve(project));
  result.findings.push(...require('./schema/prisma-schema.cjs').checkSchemaFile(root));
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
  if (engine === 'js') return analyzeSources(options);
  const result = require('./native.cjs').analyzeNative({ ...options, fallback: engine === 'auto' });
  if (!result.fallback) return result;
  const fallbackResult = analyzeSources(options);
  if (result.reason) {
    const { version } = require('typescript');
    console.error(
      `Note: TypeScript 7 cannot load this project (${firstReason(result.reason)}); used TypeScript ${version}.`,
    );
  }
  return fallbackResult;
}

function selectFindings(result, values) {
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

function printResult(result, values) {
  // Ids are assigned before filtering, so collision suffixes do not depend on which findings are shown.
  assignFindingIds(result.findings, findingRoot(values.project));
  selectFindings(result, values);
  if (values.changedLines) {
    result.findings = require('./changed-lines.cjs').keepChangedFindings(result.findings, values.changedLines);
  }
  const contractOnly = values['fail-on'] === 'contract';
  if (contractOnly) {
    result.contractFindingCount = result.findings.filter(({ ruleId }) => ruleId === 'pg-transaction-on-pool').length;
  }
  const { attachExample, findingDetailLines, findingLabel } = require('./finding-text.cjs');
  require('./site-fix.cjs').attachSiteFixes(result.findings);
  for (const finding of result.findings) {
    finding.fixable = Boolean(finding.fix);
    attachExample(finding);
  }
  if (values.json) console.log(JSON.stringify(result, null, values.watch ? 0 : 2));
  else if (values.changedLines) printChangedFindings(result.findings);
  else {
    for (const finding of result.findings) {
      const { file, line, column, message, contextualReason } = finding;
      console.log(
        `${file}:${line}:${column} ${findingLabel(finding)} ${message}${contextualReason ? ' (' + contextualReason + ')' : ''}`,
      );
      for (const detail of findingDetailLines(finding)) console.log(detail);
    }
    const summary = `${result.scannedFiles} file(s) checked, ${result.findings.length} finding(s)`;
    console.log(
      contractOnly ? `${summary}, ${result.contractFindingCount} enforced by --fail-on contract.` : summary + '.',
    );
    if (result.contextualFindingCount && !values['include-contextual']) {
      console.log(`${result.contextualFindingCount} contextual finding(s) available with --include-contextual.`);
    }
  }
  return (contractOnly ? result.contractFindingCount : result.findings.length) ? 1 : 0;
}

// Terse form for commits: where it is, what it says, then the exact command to fix or dismiss it.
function printChangedFindings(findings) {
  const { findingLabel } = require('./finding-text.cjs');
  for (const finding of findings) {
    console.log(`${finding.file}:${finding.line} ${findingLabel(finding)} ${finding.message}`);
    if (finding.fixable) console.log(`  fix:     npx warden-backend --fix --only ${finding.id}`);
    console.log(`  dismiss: // loadwise-reviewed ${finding.ruleId} -- <reason>`);
  }
  const fixableIds = findings.filter((finding) => finding.fixable).map((finding) => finding.id);
  if (fixableIds.length > 1) console.log(`Fix all: npx warden-backend --fix --only ${fixableIds.join(',')}`);
  console.log(
    findings.length
      ? `${findings.length} new finding(s) in changed lines. Apply fixes, then \`git add\` the files and commit again.`
      : 'No new findings in changed lines.',
  );
}

// Reads only the two scope flags, so an empty change set can exit before TypeScript or the SQL parser loads.
function readChangedScope(args) {
  const { values, positionals } = parseCommand(args, sourceCheckOptions);
  if (values.help || (!values.staged && values['changed-since'] === undefined)) return undefined;
  if (values.staged && values['changed-since'] !== undefined) {
    throw new Error('Choose either --staged or --changed-since.');
  }
  if (positionals.length || values.watch || values.fix) {
    throw new Error('--staged and --changed-since cannot be combined with explicit files, --watch or --fix.');
  }
  const { collectChangedLines, fileKey } = require('./changed-lines.cjs');
  const changedLines = collectChangedLines({ staged: values.staged, ref: values['changed-since'] });
  return { changedLines, isChangedFile: (filename) => changedLines.has(fileKey(filename)) };
}

async function main(args) {
  if (args[0] === 'editor') {
    if (args[1] === 'init' && args.length === 2) {
      const setup = require('./editor-setup.cjs').setupEditor(process.cwd());
      console.log((setup.changed ? 'Configured ' : 'Already configured: ') + setup.filename);
      console.log(
        'Open or reopen the trusted folder in VS Code or Cursor and allow automatic tasks once. Terminal source scans refresh the active watcher.',
      );
      return 0;
    }
    if (args[1] !== 'watch') throw new Error('Usage: warden-backend editor init  |  editor watch [-p tsconfig.json]');
    const { values, positionals } = parseCommand(args.slice(2), { project: { type: 'string', short: 'p' } });
    if (values.help) return showHelp();
    if (positionals.length) throw new Error('editor watch accepts only an optional -p project config.');
    await loadSqlParser();
    require('./editor-watch.cjs').watchEditor(process.cwd(), values.project, (inputs) =>
      checkCode(inputs, selectFindings),
    );
    return 0;
  }
  if (args[0] === 'agent') return require('../shared/agent-init.cjs').runAgentCommand(args.slice(1));
  // Lazy, so source scans and the editor watcher never load migration parsing or database drivers.
  if (args[0] === 'migrations') return require('./migrations/cli.cjs').run(args.slice(1));
  if (args[0] === 'db') return require('./db/cli.cjs').run(args.slice(1));
  if (args[0] === 'traces') return checkTraces(args.slice(1));
  if (args[0] === 'plan') return checkPlan(args.slice(1));
  if (args[0] === 'polyglot') {
    const { values, positionals } = parseCommand(args.slice(1), { json: { type: 'boolean' } });
    if (values.help) return showHelp();
    if (!positionals.length) throw new Error('Pass at least one file or directory to polyglot.');
    const { checkPolyglot } = require('./polyglot.cjs');
    const result = await checkPolyglot(positionals);
    const code = printResult(result, { ...values, ignore: [] });
    require('./notify-editor.cjs').notifyEditor(positionals.length === 1 ? positionals[0] : process.cwd());
    return code;
  }
  const scope = readChangedScope(args);
  if (scope && !scope.changedLines.size) {
    console.log(
      args.includes('--json') ? '{"scannedFiles":0,"findings":[]}' : 'No changed JavaScript or TypeScript files.',
    );
    return 0;
  }
  await loadSqlParser();
  return checkCode(args, printResult, scope);
}

// Raw SQL index rules parse synchronously during the scan, and the WASM parser can only load asynchronously.
function loadSqlParser() {
  return require('./sql/pg-parser.cjs').ensureLoaded();
}

module.exports = { main };
