'use strict';

// `agent init --hook block|warn|off`: runs `--staged` from a git pre-commit hook, so any tool that commits through git
// sees the findings on the lines it changed. The hook text lives between markers, so re-running replaces only that
// block and never touches what other tools put in the same file.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const toolName = 'maintainability-check';
const blockStart = `# >>> ${toolName} pre-commit (managed by \`${toolName} agent init --hook\`)`;
const blockEnd = `# <<< ${toolName} pre-commit`;
const hookModes = ['block', 'warn', 'off'];
const lefthookFiles = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml'];
const executableMode = 0o755;

function gitOutput(directory, args) {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.error?.code === 'ENOENT') throw new Error('git is required for --hook.');
  if (result.status !== 0) throw new Error('--hook needs a git repository: ' + result.stderr.trim());
  return result.stdout.trim();
}

function projectPathFromGitRoot(gitRoot, projectRoot) {
  const relative = path.relative(gitRoot, projectRoot).split(path.sep).join('/');
  return relative || '.';
}

function checkCommand(mode) {
  return `node_modules/.bin/${toolName} --staged .` + (mode === 'block' ? ' || exit 1' : ' || true');
}

function hookBlock(mode, projectPath) {
  return [
    blockStart,
    `( cd "${projectPath}" && if [ -x node_modules/.bin/${toolName} ]; then`,
    `    ${checkCommand(mode)}`,
    `  else echo "${toolName}: not installed here, skipped"; fi )` + (mode === 'block' ? ' || exit 1' : ''),
    blockEnd,
  ].join('\n');
}

function blockRange(text) {
  const start = text.indexOf(blockStart);
  const end = text.indexOf(blockEnd, start);
  if (start === -1 || end === -1) return undefined;
  return { start, end: end + blockEnd.length };
}

function withHookBlock(existing, block) {
  if (existing === undefined || existing.trim() === '') return '#!/bin/sh\n\n' + block + '\n';
  const range = blockRange(existing);
  if (range) return existing.slice(0, range.start) + block + existing.slice(range.end);
  return existing.replace(/\n*$/, '\n\n') + block + '\n';
}

// Returns undefined when the hook holds nothing but our block, so the caller can delete the file we created.
function withoutHookBlock(existing) {
  const range = blockRange(existing);
  if (!range) return existing;
  const remaining = (existing.slice(0, range.start) + existing.slice(range.end)).replace(/\n{3,}/g, '\n\n');
  return remaining.replace(/^#!.*\n?/, '').trim() === '' ? undefined : remaining.replace(/\n*$/, '\n');
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

// Returns { action, filename?, command? }; action is written, unchanged, removed, absent or lefthook.
function installHook(projectRoot, mode) {
  if (!hookModes.includes(mode)) throw new Error('--hook must be block, warn or off.');
  const gitRoot = path.resolve(gitOutput(projectRoot, ['rev-parse', '--show-toplevel']));
  const projectPath = projectPathFromGitRoot(gitRoot, projectRoot);
  if (mode !== 'off' && lefthookFiles.some((name) => fs.existsSync(path.join(gitRoot, name)))) {
    return { action: 'lefthook', command: `cd "${projectPath}" && ${checkCommand(mode)}` };
  }
  const filename = hookFilename(gitRoot);
  const existing = readIfPresent(filename);
  if (mode === 'off') return removeHook(filename, existing);
  const next = withHookBlock(existing, hookBlock(mode, projectPath));
  if (next !== existing) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, next);
  }
  fs.chmodSync(filename, executableMode);
  return { action: next === existing ? 'unchanged' : 'written', filename };
}

function removeHook(filename, existing) {
  if (existing === undefined || !blockRange(existing)) return { action: 'absent', filename };
  const next = withoutHookBlock(existing);
  if (next === undefined) fs.rmSync(filename);
  else fs.writeFileSync(filename, next);
  return { action: 'removed', filename };
}

module.exports = { installHook, hookModes };
