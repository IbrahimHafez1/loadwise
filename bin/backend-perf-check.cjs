#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { knownRules } = require('../lib/rule-ids.cjs');

const usage = `Usage:
  backend-perf-check [-p tsconfig.json | file.ts file.js ...] [--engine auto|native|js] [--policy policy.json] [--schema snapshot.json] [--json] [--include-contextual] [--ignore rule-id] [--fail-on all|contract] [--fix [--yes]]
  backend-perf-check --watch [-p tsconfig.json] [--policy policy.json] [--schema snapshot.json] [--include-contextual] [--ignore rule-id]
  backend-perf-check migrations [paths...] [--changed-since git-ref] [--baseline file] [--write-baseline] [--dialect postgres|mysql] [--json] [--include-contextual] [--ignore rule-id]
  backend-perf-check db [--url-env DATABASE_URL] [--env-file .env] [--engine postgres|mysql|mongo] [--schema-snapshot out.json] [--top 20] [--queries file.sql] [--analyze] [--measure --i-understand-this-locks-tables] [--runs 5] [--json] [--ignore rule-id]
  backend-perf-check traces trace.json [--threshold 5] [--json]
  backend-perf-check plan explain.json [--json]
  backend-perf-check polyglot <file-or-directory> ... [--json]
  backend-perf-check editor init
  backend-perf-check editor watch [-p tsconfig.json]

With no arguments, check tsconfig.json or jsconfig.json in the current directory.
Source checks look for backend-perf.policy.json beside the selected config, or in the working directory for explicit files.
--fix shows each available code fix and asks before applying it; --fix --yes applies every one without asking.
Source checks summarize contextual findings. --include-contextual includes their locations and review reasons.
Source checks use the TypeScript 7 native compiler when it is installed and accepts the project, otherwise TypeScript 6.
--engine native requires TypeScript 7 (--native is an alias). --engine js always uses TypeScript 6.
--fail-on contract exits 1 only for data-access-boundary.
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
  const { inspectPlan } = require('../lib/plans.cjs');
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
  const { inspectTraces } = require('../lib/traces.cjs');
  const { formatImpact } = require('../lib/impact.cjs');
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
  const { resolveConfig } = require('../lib/source-inputs.cjs');
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
        const policy = require('../lib/query-policy.cjs').loadQueryPolicy(filename);
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

function checkCode(args, report = printResult) {
  const { values, positionals } = parseCommand(args, {
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
  });
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
  if (values.fix && (values.watch || values.json)) throw new Error('--fix cannot be combined with --watch or --json.');
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
    const { watchProject } = require('../lib/watch.cjs');
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
    { project: values.project, files: positionals, policy },
    report === printResult ? engine : 'js',
  );
  if (values.project) appendPrismaSchemaFindings(result, values.project);
  if (values.fix && report === printResult) {
    selectFindings(result, values);
    return require('../lib/fix-cli.cjs').applyFixes(result.findings, { all: values.yes });
  }
  const code = report(result, values);
  if (report === printResult) require('../lib/notify-editor.cjs').notifyEditor(values.project ?? process.cwd());
  return code;
}

// schema.prisma is not TypeScript, so its foreign-key findings come from the parsed schema after the scan.
function appendPrismaSchemaFindings(result, project) {
  const { findProjectRoot } = require('../lib/schema/context.cjs');
  const root = findProjectRoot(path.resolve(project));
  result.findings.push(...require('../lib/schema/prisma-schema.cjs').checkSchemaFile(root));
}

// The snapshot is optional; without it every rule still reports, using unknown-size wording.
function loadSchemaSnapshot(filename) {
  const { loadSnapshot, useSnapshot } = require('../lib/schema/context.cjs');
  useSnapshot(filename === undefined ? undefined : loadSnapshot(path.resolve(filename)));
}

// Only the first sentence: the full TypeScript 7 diagnostic list repeats itself and buries the findings.
function firstReason(reason) {
  return reason.split(/(?<=\.)\s+/)[0].replace(/\.$/, '');
}

// Loading the JS engine binds the shared rules to TypeScript 6, so it is required only once native is ruled out.
function analyzeSourceCode(options, engine) {
  const analyzeSources = (sourceOptions) => require('../lib/projects.cjs').analyzeSources(sourceOptions);
  if (engine === 'js') return analyzeSources(options);
  const result = require('../lib/native.cjs').analyzeNative({ ...options, fallback: engine === 'auto' });
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
    let contextualCount = 0;
    result.findings = result.findings.filter((finding) => {
      if (!finding.contextualReason) return true;
      contextualCount++;
      return values['include-contextual'];
    });
    if (contextualCount) result.contextualFindingCount = contextualCount;
  }
  return result.findings;
}

function printResult(result, values) {
  selectFindings(result, values);
  const contractOnly = values['fail-on'] === 'contract';
  if (contractOnly) {
    result.contractFindingCount = result.findings.filter(({ ruleId }) => ruleId === 'data-access-boundary').length;
  }
  const { attachExample, findingDetailLines } = require('../lib/finding-text.cjs');
  require('../lib/site-fix.cjs').attachSiteFixes(result.findings);
  for (const finding of result.findings) attachExample(finding);
  if (values.json) console.log(JSON.stringify(result, null, values.watch ? 0 : 2));
  else {
    for (const finding of result.findings) {
      const { file, line, column, ruleId, message, contextualReason } = finding;
      console.log(
        `${file}:${line}:${column} [${ruleId}] ${message}${contextualReason ? ' (' + contextualReason + ')' : ''}`,
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

async function main(args) {
  if (args[0] === 'editor') {
    if (args[1] === 'init' && args.length === 2) {
      const setup = require('../lib/editor-setup.cjs').setupEditor(process.cwd());
      console.log((setup.changed ? 'Configured ' : 'Already configured: ') + setup.filename);
      console.log(
        'Open or reopen the trusted folder in VS Code or Cursor and allow automatic tasks once. Terminal source scans refresh the active watcher.',
      );
      return 0;
    }
    if (args[1] !== 'watch')
      throw new Error('Usage: backend-perf-check editor init  |  editor watch [-p tsconfig.json]');
    const { values, positionals } = parseCommand(args.slice(2), { project: { type: 'string', short: 'p' } });
    if (values.help) return showHelp();
    if (positionals.length) throw new Error('editor watch accepts only an optional -p project config.');
    await loadSqlParser();
    require('../lib/editor-watch.cjs').watchEditor(process.cwd(), values.project, (inputs) =>
      checkCode(inputs, selectFindings),
    );
    return 0;
  }
  // Lazy, so source scans and the editor watcher never load migration parsing or database drivers.
  if (args[0] === 'migrations') return require('../lib/migrations/cli.cjs').run(args.slice(1));
  if (args[0] === 'db') return require('../lib/db/cli.cjs').run(args.slice(1));
  if (args[0] === 'traces') return checkTraces(args.slice(1));
  if (args[0] === 'plan') return checkPlan(args.slice(1));
  if (args[0] === 'polyglot') {
    const { values, positionals } = parseCommand(args.slice(1), { json: { type: 'boolean' } });
    if (values.help) return showHelp();
    if (!positionals.length) throw new Error('Pass at least one file or directory to polyglot.');
    const { checkPolyglot } = require('../lib/polyglot.cjs');
    const result = await checkPolyglot(positionals);
    const code = printResult(result, { ...values, ignore: [] });
    require('../lib/notify-editor.cjs').notifyEditor(positionals.length === 1 ? positionals[0] : process.cwd());
    return code;
  }
  await loadSqlParser();
  return checkCode(args);
}

// Raw SQL index rules parse synchronously during the scan, and the WASM parser can only load asynchronously.
function loadSqlParser() {
  return require('../lib/sql/pg-parser.cjs').ensureLoaded();
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
