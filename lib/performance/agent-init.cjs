'use strict';

// `agent init`: writes instructions that tell an AI coding agent how to run this checker and act on its findings.
// Every agent reads AGENTS.md; Claude Code reads CLAUDE.md, so that file imports AGENTS.md.
const fs = require('node:fs');
const path = require('node:path');
const { findProjectRoot } = require('./schema/context.cjs');

const toolName = 'warden-backend';
const legacyToolName = 'backend-perf-check';
const blockStart = `<!-- ${toolName}:agent:start -->`;
const blockEnd = `<!-- ${toolName}:agent:end -->`;
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
    '- Run `npx warden-backend --json` (or `-p <tsconfig>`) after changing backend code and before saying a task is done.',
    '- When migrations changed, also run `npx warden-backend migrations --json`.',
    '- For each finding, by `id`:',
    '1. Read the flagged code and the message. Decide whether the finding is real in this codebase.',
    '2. Real, with a `fix`: read the diff and the `note`. Apply it with `npx warden-backend --fix --only <id>`, then run the tests or typecheck.',
    '   - Several ids can share one change; an id under `alreadyApplied` succeeded. Only ids under `failed` need attention.',
    ...modeLines[mode],
    '4. False positive or intended: add `// warden-reviewed <rule-id> -- <specific reason>` on the line above. Never use a generic reason.' +
      (mode === 'ask' ? ' List the comments you added.' : ''),
    '5. Findings with `contextualReason` are not failures. Mention them only if they relate to the current change.',
    '- Never run `--fix --yes` on everything without reviewing each fix.',
    '- Never suppress findings with `--ignore` to make the run pass.',
    '- Re-run the checker afterwards to confirm.',
    '- If a git pre-commit hook is installed (`agent init --hook`), commits run `--staged` on the changed lines. Fix each reported id with `npx warden-backend --fix --only <id>`, or dismiss it with a `// warden-reviewed <rule-id> -- <reason>` comment, then `git add` and commit again. Use `--no-verify` only if the user agrees.',
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

// Replaces this tool's block in place (an older install's block included), or appends it; text outside is never changed.
function withBlock(existing, block) {
  if (existing === undefined || existing.trim() === '') return block + '\n';
  for (const [startMarker, endMarker] of [
    [blockStart, blockEnd],
    [legacyBlockStart, legacyBlockEnd],
  ]) {
    const start = existing.indexOf(startMarker);
    const end = existing.indexOf(endMarker, start);
    if (start !== -1 && end !== -1) {
      return existing.slice(0, start) + block + existing.slice(end + endMarker.length);
    }
  }
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

module.exports = { initAgent, agentBlock };
