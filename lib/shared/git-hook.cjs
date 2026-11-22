'use strict';

// `agent init --hook block|warn|off`: runs `loadwise check --staged` from the git pre-commit hook, so any tool that
// commits through git gets findings on the lines it changed. The block is marked so other hooks' text survives.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('./atomic-write.cjs');
const { replaceBlocks } = require('./managed-blocks.cjs');

const toolName = 'loadwise';
// Earlier releases installed one block per checker under these names; they are upgraded or removed like ours.
const legacyToolNames = ['warden-backend', 'warden-maint', 'backend-perf-check', 'maintainability-check'];
const markerPairs = [toolName, ...legacyToolNames].map((name) => [
  `# >>> ${name} pre-commit (managed by \`${name} agent init --hook\`)`,
  `# <<< ${name} pre-commit`,
]);
const [[blockStart, blockEnd]] = markerPairs;
const hookModes = ['block', 'warn', 'off'];
const lefthookFiles = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml'];
const executableMode = 0o755;
const binary = `node_modules/.bin/${toolName}`;
const checkCommand = `${binary} check --staged`;

function gitOutput(directory, args) {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.error?.code === 'ENOENT') throw new Error('git is required for --hook.');
  if (result.status !== 0) throw new Error('--hook needs a git repository: ' + result.stderr.trim());
  return result.stdout.trim();
}

function shellDoubleQuote(text) {
  return '"' + text.replace(/[\\"$`]/g, '\\$&') + '"';
}

// The hook runs under sh, which needs forward slashes even on Windows.
function projectPathFromGitRoot(gitRoot, projectRoot) {
  return path.relative(gitRoot, projectRoot).split(path.sep).join('/') || '.';
}

// The block never calls `exit 0`: other tools' blocks may follow it in the same hook.
function hookBlock(mode, projectPath) {
  const onFindings = mode === 'block' ? '|| exit 1' : '|| true';
  return [
    blockStart,
    `( cd ${shellDoubleQuote(projectPath)} && if [ -x ${binary} ]; then`,
    `    ${checkCommand} ${onFindings}`,
    `  else echo "${toolName}: not installed here, skipped"; fi )` + (mode === 'block' ? ' || exit 1' : ''),
    blockEnd,
  ].join('\n');
}

// An unindented `exit` or `exec command` ends the script, so nothing after it runs. `exec` with only redirections
// continues; indented lines are taken to sit inside a branch or function.
const unconditionalExitLine = /^(?:exit(?:\s+[^\s;#]+)?|exec\s+[^\s<>&\d][^;#]*?)\s*;?\s*(?:#.*)?$/;
const blankOrCommentLine = /^\s*(?:#.*)?$/;

function lineStarts(text) {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
  return starts.filter((start) => start < text.length);
}

function lineAt(text, start) {
  const end = text.indexOf('\n', start);
  return text.slice(start, end === -1 ? text.length : end).replace(/\r$/, '');
}

function hasExitBefore(text, offset) {
  const before = text.slice(0, offset);
  return lineStarts(before).some((start) => unconditionalExitLine.test(lineAt(before, start)));
}

// The offset of a final `exit 0` (or other unconditional exit), so the block can run before it.
function trailingExitOffset(text) {
  const lastLine = lineStarts(text).findLast((start) => !blankOrCommentLine.test(lineAt(text, start)));
  return lastLine !== undefined && unconditionalExitLine.test(lineAt(text, lastLine)) ? lastLine : undefined;
}

function insertHookBlock(existing, block) {
  const exitOffset = trailingExitOffset(existing);
  if (exitOffset === undefined) return existing.replace(/\n*$/, '\n\n') + block + '\n';
  const before = existing.slice(0, exitOffset);
  return (before ? before.replace(/\n*$/, '\n\n') : '') + block + '\n\n' + existing.slice(exitOffset);
}

// Returns { text, unreachable }: unreachable when an exit the block cannot be placed before still precedes it.
// A block that sits after an exit, as earlier releases appended it, is moved before a trailing exit.
function withHookBlock(existing, block) {
  if (existing === undefined || existing.trim() === '') return { text: '#!/bin/sh\n\n' + block + '\n' };
  const inPlace = replaceBlocks(existing, markerPairs, block);
  if (inPlace !== undefined && !hasExitBefore(inPlace, inPlace.indexOf(blockStart))) return { text: inPlace };
  const text = insertHookBlock(inPlace === undefined ? existing : replaceBlocks(existing, markerPairs), block);
  return { text, unreachable: hasExitBefore(text, text.indexOf(blockStart)) };
}

function lefthookInstructions(configName, mode, projectPath) {
  return [
    `${configName} found, so it was not edited. Add this under pre-commit.commands:`,
    `  ${toolName}:`,
    `    run: cd ${shellDoubleQuote(projectPath)} && ${checkCommand}` + (mode === 'block' ? '' : ' || true'),
  ].join('\n');
}

function readIfPresent(filename) {
  try {
    return fs.readFileSync(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function hookFilename(gitRoot) {
  if (fs.existsSync(path.join(gitRoot, '.husky'))) return path.join(gitRoot, '.husky', 'pre-commit');
  const hooksDirectory = path.resolve(gitRoot, gitOutput(gitRoot, ['rev-parse', '--git-path', 'hooks']));
  return path.join(hooksDirectory, 'pre-commit');
}

// Deletes the hook when nothing but a shebang remains, since init created it.
function removeHook(filename, existing) {
  const remaining = existing === undefined ? undefined : replaceBlocks(existing, markerPairs);
  if (remaining === undefined) return { message: `No ${toolName} pre-commit block to remove.` };
  if (remaining.replace(/^#!.*\n?/, '').trim() === '') {
    fs.rmSync(filename);
    return { filename, message: `Removed ${filename}, which held only the ${toolName} block.` };
  }
  writeFileAtomic(filename, remaining);
  return { filename, message: `Removed the ${toolName} block from ${filename}.` };
}

// Returns { message, filename? } describing what changed.
function installHook(projectRoot, mode) {
  if (!hookModes.includes(mode)) throw new Error('--hook must be block, warn or off.');
  const gitRoot = path.resolve(gitOutput(projectRoot, ['rev-parse', '--show-toplevel']));
  const projectPath = projectPathFromGitRoot(gitRoot, projectRoot);
  const lefthookName = lefthookFiles.find((name) => fs.existsSync(path.join(gitRoot, name)));
  if (mode !== 'off' && lefthookName) return { message: lefthookInstructions(lefthookName, mode, projectPath) };
  const filename = hookFilename(gitRoot);
  const existing = readIfPresent(filename);
  if (mode === 'off') return removeHook(filename, existing);
  const { text: next, unreachable } = withHookBlock(existing, hookBlock(mode, projectPath));
  const warning = unreachable
    ? `\nWarning: ${filename} runs \`exit\` or \`exec\` before the ${toolName} block, so the block may not run.`
    : '';
  if (next === existing) return { filename, message: `${filename} is already up to date.` + warning };
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  writeFileAtomic(filename, next, executableMode);
  return { filename, message: `Wrote ${filename} (${mode} mode).` + warning };
}

module.exports = { installHook };
