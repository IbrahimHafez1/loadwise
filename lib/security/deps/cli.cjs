'use strict';

// `loadwise sec deps`: known-vulnerability check of the lockfile against the OSV database. Network access is opt-in.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { scanDependencies, hasLockfile } = require('./scan.cjs');

const usage = `Usage:
  loadwise sec deps --online [directory] [--format text|json] [--json] [--include-contextual] [--ignore rule-id] [--fail-on all|contract]

Reads package-lock.json, pnpm-lock.yaml or yarn.lock from the directory (default: the current folder) or the nearest parent that has one.
--online is required: it sends the package names and versions in the lockfile, and nothing else, to the OSV vulnerability database (api.osv.dev, which includes the GitHub Advisory Database). Answers are cached for 24 hours in the loadwise folder of the OS cache directory.
Development-only dependencies are contextual and reported with --include-contextual.
A network failure exits 2; it is never reported as a pass.
Exit codes: 0 passed, 1 findings, 2 invalid input or a network failure.`;

const options = {
  help: { type: 'boolean', short: 'h' },
  online: { type: 'boolean' },
  format: { type: 'string' },
  json: { type: 'boolean' },
  'include-contextual': { type: 'boolean', default: false },
  ignore: { type: 'string', multiple: true, default: [] },
  'fail-on': { type: 'string', default: 'all' },
};

const offlineNote = 'Note: dependency vulnerability checks need --online; skipped them.';

// Prints the one-line note when a lockfile exists but the network check was not requested.
function noteOffline(directory) {
  if (hasLockfile(directory)) console.error(offlineNote);
}

function parseDepsArgs(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options });
  if (positionals.length > 1) throw new Error('sec deps accepts at most one directory.');
  if (values.format !== undefined && !['text', 'json'].includes(values.format)) {
    throw new Error('--format must be text or json.');
  }
  if (values.format === 'json') values.json = true;
  if (!['all', 'contract'].includes(values['fail-on'])) throw new Error('--fail-on must be all or contract.');
  const directory = path.resolve(positionals[0] ?? '.');
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory())
    throw new Error('Expected a project directory.');
  return { values, directory };
}

async function main(args, scanOptions) {
  const { values, directory } = parseDepsArgs(args);
  if (values.help) {
    console.log(usage);
    return 0;
  }
  if (!values.online) {
    console.error(offlineNote);
    return 0;
  }
  const result = await scanDependencies(directory, scanOptions);
  const pillar = { command: 'sec deps', contractRules: new Set() };
  return require('../../shared/source-report.cjs').printResult(result, { ...values, project: directory }, pillar);
}

module.exports = { main, usage, noteOffline };
