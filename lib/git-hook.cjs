'use strict';

// `agent init --hook block|warn|off`: runs `--staged` from the git pre-commit hook, so any tool that commits through
// git gets findings on the lines it changed. The block is marked so other hooks and other packages' blocks survive.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { findProjectRoot } = require('./schema/context.cjs');

const toolName = 'backend-perf-check';
const blockStart = `# >>> ${toolName} pre-commit (managed by \`${toolName} agent init --hook\`)`;
const blockEnd = `# <<< ${toolName} pre-commit`;
const hookModes = ['block', 'warn'];
const lefthookFiles = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml'];
const executableMode = 0o755;

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw new Error('agent init --hook needs a git repository, and git must be on PATH.');
  }
}

function shellDoubleQuote(text) {
  return '"' + text.replace(/[\\"$`]/g, '\\$&') + '"';
}

// The block never calls `exit 0`: blocks from other packages may follow it in the same hook.
function hookBlock(hookMode, projectDirectory) {
  const binary = `node_modules/.bin/${toolName}`;
  const onFindings = hookMode === 'block' ? '|| exit 1' : '|| true';
  const afterSubshell = hookMode === 'block' ? ' || exit 1' : '';
  return [
    blockStart,
    `( cd ${shellDoubleQuote(projectDirectory)} && if [ -x ${binary} ]; then`,
    `    ${binary} --staged ${onFindings}`,
    `  else echo "${toolName}: not installed here, skipped"; fi )${afterSubshell}`,
    blockEnd,
  ].join('\n');
}

// The hook runs under sh, which needs forward slashes even on Windows.
function relativeProjectDirectory(gitRoot, projectRoot) {
  return path.relative(gitRoot, projectRoot).split(path.sep).join('/') || '.';
}

function hookFilename(gitRoot) {
  if (fs.existsSync(path.join(gitRoot, '.husky'))) return path.join(gitRoot, '.husky', 'pre-commit');
  const hooksDirectory = git(['rev-parse', '--git-path', 'hooks'], gitRoot);
  return path.join(path.resolve(gitRoot, hooksDirectory), 'pre-commit');
}

function lefthookConfig(gitRoot) {
  return lefthookFiles.find((name) => fs.existsSync(path.join(gitRoot, name)));
}

function readText(filename) {
  try {
    return fs.readFileSync(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function blockRange(text) {
  const start = text.indexOf(blockStart);
  const end = text.indexOf(blockEnd, start);
  if (start === -1 || end === -1) return undefined;
  return { start, end: end + blockEnd.length };
}

// Replaces this tool's block in place, or appends it; the rest of an existing hook is never changed.
function withHookBlock(existing, block) {
  if (existing === undefined || existing.trim() === '') return `#!/bin/sh\n\n${block}\n`;
  const range = blockRange(existing);
  if (range) return existing.slice(0, range.start) + block + existing.slice(range.end);
  return existing.replace(/\n*$/, '\n\n') + block + '\n';
}

function withoutHookBlock(existing) {
  const range = blockRange(existing);
  const before = existing.slice(0, range.start).replace(/\n+$/, '\n');
  const after = existing.slice(range.end).replace(/^\n/, '');
  return before + after;
}

function lefthookInstructions(configName, hookMode) {
  const failText = hookMode === 'block' ? '' : ' || true';
  return [
    `${configName} found, so it was not edited. Add this under pre-commit.commands:`,
    `  ${toolName}:`,
    `    run: node_modules/.bin/${toolName} --staged${failText}`,
  ].join('\n');
}

function installHook(directory, hookMode = 'warn') {
  if (!hookModes.includes(hookMode)) throw new Error('--hook must be block, warn or off.');
  const projectRoot = findProjectRoot(directory);
  const gitRoot = path.resolve(git(['rev-parse', '--show-toplevel'], projectRoot));
  const lefthookName = lefthookConfig(gitRoot);
  if (lefthookName) return { message: lefthookInstructions(lefthookName, hookMode) };
  const filename = hookFilename(gitRoot);
  const existing = readText(filename);
  const block = hookBlock(hookMode, relativeProjectDirectory(gitRoot, projectRoot));
  const next = withHookBlock(existing, block);
  if (next === existing) return { filename, message: `${filename} is already up to date.` };
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, next);
  fs.chmodSync(filename, executableMode);
  return { filename, message: `Wrote ${filename} (${hookMode} mode).` };
}

function removeHook(directory) {
  const projectRoot = findProjectRoot(directory);
  const gitRoot = path.resolve(git(['rev-parse', '--show-toplevel'], projectRoot));
  const filename = hookFilename(gitRoot);
  const existing = readText(filename);
  if (existing === undefined || !blockRange(existing)) return { message: 'No pre-commit block to remove.' };
  fs.writeFileSync(filename, withoutHookBlock(existing));
  return { filename, message: `Removed the ${toolName} block from ${filename}.` };
}

module.exports = { hookBlock, installHook, removeHook };
