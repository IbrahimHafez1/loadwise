#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

const usage = `Usage:
  backend-perf-check [-p tsconfig.json | file.ts file.js ...] [--native] [--policy policy.json] [--json] [--include-contextual] [--ignore rule-id] [--fail-on all|contract]
  backend-perf-check --watch [-p tsconfig.json] [--policy policy.json] [--include-contextual] [--ignore rule-id]
  backend-perf-check traces trace.json [--threshold 5] [--json]
  backend-perf-check plan explain.json [--json]
  backend-perf-check polyglot <file-or-directory> ... [--json]

With no arguments, check tsconfig.json or jsconfig.json in the current directory.
Source checks look for backend-perf.policy.json beside the selected config, or in the working directory for explicit files.
Source checks summarize contextual findings. --include-contextual includes their locations and review reasons.
--fail-on contract exits 1 only for pg-transaction-on-pool or data-access-boundary.
The traces command reads one OTLP/JSON export. Its threshold counts sibling DB spans.
Exit codes: 0 passed, 1 findings meeting the exit threshold, 2 invalid input or configuration.`;

const sourceRules = new Set([
  'promise-combinator-serial-await',
  'numeric-sort-for-extreme',
  'known-reads-awaited-serially',
  'array-repeated-membership',
  'array-repeated-find',
  'reduce-copy-accumulator',
  'pg-query-in-loop',
  'pg-count-materialization',
  'prisma-query-in-loop',
  'prisma-count-materialization',
  'node-sync-fs-in-async',
  'rebuild-lookup-in-loop',
  'loop-copy-accumulator',
  'filter-for-existence',
  'pg-first-materialization',
  'prisma-first-materialization',
  'pg-filter-materialization',
  'prisma-filter-materialization',
  'pg-top-k-materialization',
  'prisma-top-k-materialization',
  'pool-created-per-request-or-item',
  'pg-unreleased-checkout',
  'node-sync-compression-in-async',
  'node-sync-crypto-in-async',
  'node-sync-process-in-async',
  'pg-transaction-on-pool',
  'pg-dynamic-query-text',
  'prisma-transaction-client-escape',
  'prisma-read-modify-write',
  'prisma-dependent-writes',
  'drizzle-query-in-loop',
  'drizzle-unfiltered-write',
  'orm-query-in-loop',
  'orm-count-materialization',
  'typeorm-existence-materialization',
  'typeorm-wide-projection',
  'typeorm-transaction-in-loop',
  'prisma-scope-unverified',
  'drizzle-scope-unverified',
  'data-access-boundary',
]);

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
  const result = inspectTraces(document, { threshold });
  const { findings, scannedSpans, eligibleDbSpans } = result;
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const finding of findings) {
      console.log(
        `${finding.traceId} parent ${finding.parentSpanId || '(root)'} [${finding.ruleId}] ${finding.message}`,
      );
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

function checkCode(args) {
  const { values, positionals } = parseCommand(args, {
    project: { type: 'string', short: 'p' },
    policy: { type: 'string' },
    'fail-on': { type: 'string', default: 'all' },
    'include-contextual': { type: 'boolean', default: false },
    json: { type: 'boolean' },
    watch: { type: 'boolean' },
    native: { type: 'boolean' },
    ignore: { type: 'string', multiple: true, default: [] },
  });
  if (values.help) return showHelp();
  if (values.project && positionals.length) throw new Error('Choose either a project or explicit source files.');
  if (!['all', 'contract'].includes(values['fail-on'])) throw new Error('--fail-on must be all or contract.');
  if (values.watch && values.native)
    throw new Error('--native supports one-shot checks. Use --watch with the incremental JS compiler.');
  if (values.watch && positionals.length) throw new Error('--watch requires a project config.');
  for (const ruleId of values.ignore) {
    if (!sourceRules.has(ruleId)) throw new Error('Unknown source rule: ' + ruleId);
  }
  // Node reuses bytecode for the compiler across invocations. Each run still reads the current project.
  require('node:module').enableCompileCache?.();
  const policySource = sourcePolicy(values.policy, values.project, positionals);
  const policy = policySource.read();
  if (values.watch) {
    const { watchProject } = require('../lib/watch.cjs');
    watchProject(values.project ?? '.', {
      policySource,
      onResult(result) {
        printResult(result, values);
      },
      onError(error) {
        console.error(error.message ?? error);
      },
    });
    return 0;
  }
  const analyze = values.native
    ? require('../lib/native.cjs').analyzeNative
    : require('../lib/projects.cjs').analyzeSources;
  const result = analyze({ project: values.project, files: positionals, policy });
  const code = printResult(result, values);
  require('../lib/notify-editor.cjs').notifyEditor(values.project ?? process.cwd());
  return code;
}

function printResult(result, values) {
  result.findings = result.findings.filter((finding) => !values.ignore.includes(finding.ruleId));
  if (values['include-contextual'] !== undefined) {
    const classifyTestWrite = require('../lib/review-context.cjs').createTestWriteClassifier();
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
  const contractOnly = values['fail-on'] === 'contract';
  if (contractOnly) {
    result.contractFindingCount = result.findings.filter(
      ({ ruleId }) => ruleId === 'pg-transaction-on-pool' || ruleId === 'data-access-boundary',
    ).length;
  }
  if (values.json) console.log(JSON.stringify(result, null, values.watch ? 0 : 2));
  else {
    for (const { file, line, column, ruleId, message, contextualReason } of result.findings) {
      console.log(
        `${file}:${line}:${column} [${ruleId}] ${message}${contextualReason ? ' (' + contextualReason + ')' : ''}`,
      );
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
  return checkCode(args);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
