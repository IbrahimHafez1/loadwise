'use strict';

// `agent init`: writes instructions that tell an AI coding agent how to run both checkers and act on their findings.
// Every agent reads AGENTS.md; Claude Code reads CLAUDE.md, so that file imports AGENTS.md.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { replaceBlocks } = require('./managed-blocks.cjs');

const toolName = 'loadwise';
// Earlier releases wrote one block per checker under these names; init upgrades them to the single loadwise block.
const legacyToolNames = ['warden-backend', 'warden-maint', 'backend-perf-check', 'maintainability-check'];
const markerPairs = [toolName, ...legacyToolNames].map((name) => [
  `<!-- ${name}:agent:start -->`,
  `<!-- ${name}:agent:end -->`,
]);
const [[blockStart, blockEnd]] = markerPairs;
const agentsFile = 'AGENTS.md';
const claudeFile = 'CLAUDE.md';
const claudeImport = '@AGENTS.md';
const modes = ['ask', 'auto'];
const usage = 'Usage: loadwise agent init [--mode ask|auto] [--hook [block|warn|off]]';

const modeLines = {
  ask: [
    '   - Ask mode: show the user a one-line summary per fix and wait for approval before applying.',
    '3. Real, with no `fix`: propose a concrete change and wait for the user.',
  ],
  auto: [
    '   - Auto mode: apply fixes whose `note` has no behaviour caveat. Ask about any whose note describes a trade-off (a TTL, an ordering change, semantics).',
    '3. Real, with no `fix`: propose a concrete change. Make it if it is local and covered by tests; otherwise ask.',
  ],
};

function agentBlock(mode) {
  return [
    blockStart,
    `## ${toolName}`,
    '',
    `Mode: ${mode} (change to ask or auto; ask waits for the user before changing code).`,
    '',
    '- Run `npx loadwise --json` after changing code and before saying a task is done. It runs the performance checker (`performance` in the output) and the maintainability checker (`maintainability`); `npx loadwise perf` or `npx loadwise maint` runs one of them.',
    '- When migrations changed, also run `npx loadwise perf migrations --json`.',
    '- Maintainability findings are readability and structure advice. For each finding, by `id`:',
    '1. Read the flagged code and the message. Decide whether the finding is real in this codebase.',
    '2. Real, with a `fix`: read the diff and the `note`. Apply it with `npx loadwise perf --fix --only <id>` for a performance finding or `npx loadwise maint --fix --only <id>` for a maintainability finding, then run the tests or typecheck.',
    '   - Several ids can share one change; an id under `alreadyApplied` succeeded. Only ids under `failed` need attention.',
    ...modeLines[mode],
    '   - In both modes, always ask before changing `duplicate-implementation` or `dependency-cycle` findings: they are design decisions.',
    '4. False positive or intended: add `// loadwise-reviewed <rule-id> -- <specific reason>` on the line above. Never use a generic reason. Declared contract rules cannot be dismissed this way.' +
      (mode === 'ask' ? ' List the comments you added.' : ''),
    '5. Findings with `contextualReason` are not failures. Mention them only if they relate to the current change.',
    '- Never run `--fix --yes` on everything without reviewing each fix.',
    '- Never suppress findings with `--ignore` to make the run pass.',
    '- Re-run the checker afterwards to confirm.',
    '- If a git pre-commit hook is installed (`loadwise agent init --hook`), commits run `loadwise check --staged` on the changed lines. Fix each reported id with the printed `--fix --only <id>` command, or dismiss it with a `// loadwise-reviewed <rule-id> -- <reason>` comment, then `git add` and commit again. Use `--no-verify` only if the user agrees.',
    '- Report to the user a table of id, rule, file:line and action (applied, changed, dismissed with reason, or left for the user).',
    blockEnd,
  ].join('\n');
}

function readText(filename) {
  try {
    return fs.readFileSync(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function withBlock(existing, block) {
  if (existing === undefined || existing.trim() === '') return block + '\n';
  return replaceBlocks(existing, markerPairs, block) ?? existing.replace(/\n*$/, '\n\n') + block + '\n';
}

function withClaudeImport(existing) {
  if (existing === undefined) return claudeImport + '\n';
  if (existing.split(/\r?\n/).some((line) => line.trim() === claudeImport)) return existing;
  return existing.replace(/\n*$/, existing.trim() ? '\n\n' : '') + claudeImport + '\n';
}

function writeIfChanged(filename, update) {
  const existing = readText(filename);
  const next = update(existing);
  if (next === existing) return false;
  fs.writeFileSync(filename, next);
  return true;
}

// The nearest package.json marks the project the instructions and the hook belong to.
function findProjectRoot(start) {
  const directory = path.resolve(start);
  for (let candidate = directory; ; candidate = path.dirname(candidate)) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(candidate) === candidate) return directory;
  }
}

// Returns the files it wrote; an unchanged file is not rewritten.
function initAgent(directory, mode = 'ask') {
  if (!modes.includes(mode)) throw new Error('--mode must be ask or auto.');
  const root = findProjectRoot(directory);
  const written = [];
  for (const [name, update] of [
    [agentsFile, (existing) => withBlock(existing, agentBlock(mode))],
    [claudeFile, withClaudeImport],
  ]) {
    const filename = path.join(root, name);
    if (writeIfChanged(filename, update)) written.push(filename);
  }
  return written;
}

// `--hook` alone means warn, which parseArgs cannot express for a string option.
function withDefaultHookMode(args) {
  return args.flatMap((arg, index) => {
    const isBareHook = arg === '--hook' && (index === args.length - 1 || args[index + 1].startsWith('-'));
    return isBareHook ? [arg, 'warn'] : [arg];
  });
}

// `agent init [--mode ask|auto] [--hook [block|warn|off]]`, shared by `loadwise`, `loadwise perf` and `loadwise maint`.
function runAgentCommand(args) {
  if (args[0] !== 'init') throw new Error(usage);
  const { values, positionals } = parseArgs({
    args: withDefaultHookMode(args.slice(1)),
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      mode: { type: 'string', default: 'ask' },
      hook: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(usage);
    return 0;
  }
  if (positionals.length) throw new Error('agent init accepts only --mode ask|auto and --hook block|warn|off.');
  const written = initAgent(process.cwd(), values.mode);
  for (const filename of written) console.log('Wrote ' + filename);
  if (!written.length) console.log('AGENTS.md and CLAUDE.md are already up to date.');
  if (values.hook !== undefined) {
    console.log(require('./git-hook.cjs').installHook(findProjectRoot(process.cwd()), values.hook).message);
  }
  return 0;
}

module.exports = { initAgent, agentBlock, runAgentCommand };
