'use strict';

// `agent init`: writes instructions that tell an AI coding agent how to run this checker and act on its findings.
// Every agent reads AGENTS.md; Claude Code reads CLAUDE.md, so that file imports AGENTS.md.
const fs = require('node:fs');
const path = require('node:path');

const toolName = 'warden-maint';
const blockStart = `<!-- ${toolName}:agent:start -->`;
const blockEnd = `<!-- ${toolName}:agent:end -->`;
const legacyToolName = 'maintainability-check';
const legacyBlockStart = `<!-- ${legacyToolName}:agent:start -->`;
const legacyBlockEnd = `<!-- ${legacyToolName}:agent:end -->`;
const agentsFile = 'AGENTS.md';
const claudeFile = 'CLAUDE.md';
const claudeImport = '@AGENTS.md';
const modes = ['ask', 'auto'];

const modeLines = {
  ask: [
    '   - Ask mode: show the user a one-line summary per fix and wait for approval before applying.',
    '3. Real, with no `fix`: propose a concrete change and wait for the user.',
  ],
  auto: [
    '   - Auto mode: apply fixes whose `note` has no behaviour caveat. Ask about any whose note describes a trade-off.',
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
    '- Run `npx warden-maint --json .` after changing code and before saying a task is done.',
    '- Findings are readability and structure advice. For each finding, by `id`:',
    '1. Read the flagged code and the message. Decide whether the finding is real in this codebase.',
    '2. Real, with a `fix`: read the diff and the `note`. Apply it with `npx warden-maint . --fix --only <id>`, then run the tests or typecheck.',
    ...modeLines[mode],
    '   - In both modes, always ask before changing `duplicate-implementation` or `dependency-cycle` findings: they are design decisions.',
    '4. False positive or intended: add `// warden-reviewed <rule-id> -- <specific reason>` on the line above. Never use a generic reason. Declared contract rules cannot be dismissed this way.' +
      (mode === 'ask' ? ' List the comments you added.' : ''),
    '5. Findings with `contextualReason` are not failures. Mention them only if they relate to the current change.',
    '- Commits may run `npx warden-maint --staged` on the lines you changed (installed by `agent init --hook`). Fix a reported finding by `id`, or dismiss it with a review comment on the line above; use `git commit --no-verify` only if the user agrees.',
    '- Never run `--fix --yes` on everything without reviewing each fix.',
    '- Re-run the checker afterwards to confirm.',
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

function findBlock(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  if (start === -1 || end === -1) return undefined;
  return { start, end: end + endMarker.length };
}

// Replaces this tool's block in place (an older install's block included), or appends it; text outside the block is
// never changed.
function withBlock(existing, block) {
  if (existing === undefined || existing.trim() === '') return block + '\n';
  const range = findBlock(existing, blockStart, blockEnd) ?? findBlock(existing, legacyBlockStart, legacyBlockEnd);
  if (range) return existing.slice(0, range.start) + block + existing.slice(range.end);
  return existing.replace(/\n*$/, '\n\n') + block + '\n';
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

module.exports = { initAgent, agentBlock, findProjectRoot };
