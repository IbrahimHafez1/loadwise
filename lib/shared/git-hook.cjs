'use strict';

// `agent init --hook block|warn|off`: runs `loadwise check --staged` from the git pre-commit hook, so any tool that
// commits through git gets findings on the lines it changed. The block is marked so other hooks' text survives.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
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

function withHookBlock(existing, block) {
  if (existing === undefined || existing.trim() === '') return '#!/bin/sh\n\n' + block + '\n';
  return replaceBlocks(existing, markerPairs, block) ?? existing.replace(/\n*$/, '\n\n') + block + '\n';
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
  fs.writeFileSync(filename, remaining);
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
  const next = withHookBlock(existing, hookBlock(mode, projectPath));
  if (next === existing) return { filename, message: `${filename} is already up to date.` };
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, next);
  fs.chmodSync(filename, executableMode);
  return { filename, message: `Wrote ${filename} (${mode} mode).` };
}

module.exports = { installHook };
