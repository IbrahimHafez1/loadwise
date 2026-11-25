// @ts-check
// `agent init --hook block|warn|off`: runs `loadwise check --staged` from the git pre-commit hook, so any tool that
// commits through git gets findings on the lines it changed. The block is marked so other hooks' text survives.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.js';
import { realTarget } from './real-target.js';
import { replaceBlocks } from './managed-blocks.js';
import { errorCode } from './error-code.js';
import type { MarkerPair } from './types/managed-blocks.js';

type HookMode = 'block' | 'warn' | 'off';

/** The hook text to write and whether an earlier `exit` keeps the block from running. */
interface HookText {
  text: string;
  unreachable?: boolean;
}

interface HookInstallResult {
  message: string;
  filename?: string;
}

const toolName = 'loadwise';
// Earlier releases installed one block per checker under these names; they are upgraded or removed
// like ours.
const legacyToolNames = ['warden-backend', 'warden-maint', 'backend-perf-check', 'maintainability-check'];
const markerPairs = [toolName, ...legacyToolNames].map((name): MarkerPair => [
  `# >>> ${name} pre-commit (managed by \`${name} agent init --hook\`)`,
  `# <<< ${name} pre-commit`,
]);
const [[blockStart, blockEnd]] = markerPairs;
const hookModes: readonly HookMode[] = ['block', 'warn', 'off'];
const lefthookFiles = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml'];
const executableMode = 0o755;
const binary = `node_modules/.bin/${toolName}`;
const checkCommand = `${binary} check --staged`;

function gitOutput(directory: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true });
  if (errorCode(result.error) === 'ENOENT') throw new Error('git is required for --hook.');
  if (result.status !== 0) throw new Error('--hook needs a git repository: ' + result.stderr.trim());
  return result.stdout.trim();
}

function shellDoubleQuote(text: string) {
  return '"' + text.replaceAll(/[\\"$`]/g, '\\$&') + '"';
}

// The hook runs under sh, which needs forward slashes even on Windows.
function projectPathFromGitRoot(gitRoot: string, projectRoot: string): string {
  return path.relative(gitRoot, projectRoot).split(path.sep).join('/') || '.';
}

// The block never calls `exit 0`: other tools' blocks may follow it in the same hook.
function hookBlock(mode: HookMode, projectPath: string): string {
  const onFindings = mode === 'block' ? '|| exit 1' : '|| true';
  return [
    blockStart,
    `( cd ${shellDoubleQuote(projectPath)} && if [ -x ${binary} ]; then`,
    `    ${checkCommand} ${onFindings}`,
    `  else echo "${toolName}: not installed here, skipped"; fi )` + (mode === 'block' ? ' || exit 1' : ''),
    blockEnd,
  ].join('\n');
}

// An unindented `exit` or `exec command` ends the script, so nothing after it runs. `exec` with
// only redirections continues; indented lines are taken to sit inside a branch or function.
const unconditionalExitLine = /^(?:exit(?:\s+[^\s;#]+)?|exec\s+[^\s<>&\d][^;#]*?)\s*;?\s*(?:#.*)?$/;
const blankOrCommentLine = /^\s*(?:#.*)?$/;

function lineStarts(text: string) {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
  return starts.filter((start) => start < text.length);
}

function lineAt(text: string, start: number) {
  const end = text.indexOf('\n', start);
  return text.slice(start, end === -1 ? text.length : end).replace(/\r$/, '');
}

function hasExitBefore(text: string, offset: number) {
  const before = text.slice(0, offset);
  return lineStarts(before).some((start) => unconditionalExitLine.test(lineAt(before, start)));
}

// The offset of a final `exit 0` (or other unconditional exit), so the block can run before it.
function trailingExitOffset(text: string) {
  const lastLine = lineStarts(text).findLast((start) => !blankOrCommentLine.test(lineAt(text, start)));
  return lastLine !== undefined && unconditionalExitLine.test(lineAt(text, lastLine)) ? lastLine : undefined;
}

function insertHookBlock(existing: string, block: string): string {
  const exitOffset = trailingExitOffset(existing);
  if (exitOffset === undefined) return existing.replace(/\n*$/, '\n\n') + block + '\n';
  const before = existing.slice(0, exitOffset);
  return (before ? before.replace(/\n*$/, '\n\n') : '') + block + '\n\n' + existing.slice(exitOffset);
}

// Returns { text, unreachable }: unreachable when an exit the block cannot be placed before still
// precedes it. A block that sits after an exit, as earlier releases appended it, is moved before a
// trailing exit.
function withHookBlock(existing: string | undefined, block: string): HookText {
  if (existing === undefined || existing.trim() === '') return { text: '#!/bin/sh\n\n' + block + '\n' };
  const inPlace = replaceBlocks(existing, markerPairs, block);
  if (inPlace !== undefined && !hasExitBefore(inPlace, inPlace.indexOf(blockStart))) return { text: inPlace };
  const text = insertHookBlock(
    inPlace === undefined ? existing : (replaceBlocks(existing, markerPairs) ?? existing),
    block,
  );
  return { text, unreachable: hasExitBefore(text, text.indexOf(blockStart)) };
}

function lefthookInstructions(configName: string, mode: HookMode, projectPath: string): string {
  return [
    `${configName} found, so it was not edited. Add this under pre-commit.commands:`,
    `  ${toolName}:`,
    `    run: cd ${shellDoubleQuote(projectPath)} && ${checkCommand}` + (mode === 'block' ? '' : ' || true'),
  ].join('\n');
}

function readIfPresent(filename: string): string | undefined {
  try {
    return fs.readFileSync(filename, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function hookFilename(gitRoot: string): string {
  if (fs.existsSync(path.join(gitRoot, '.husky'))) return path.join(gitRoot, '.husky', 'pre-commit');
  const hooksDirectory = path.resolve(gitRoot, gitOutput(gitRoot, ['rev-parse', '--git-path', 'hooks']));
  return path.join(hooksDirectory, 'pre-commit');
}

// Deletes the hook when nothing but a shebang remains, since init created it.
function removeHook(filename: string, existing: string | undefined): HookInstallResult {
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
function isHookMode(mode: string): mode is HookMode {
  return hookModes.some((candidate) => candidate === mode);
}

function installHook(projectRoot: string, mode: string): HookInstallResult {
  if (!isHookMode(mode)) throw new Error('--hook must be block, warn or off.');
  const gitRoot = path.resolve(gitOutput(projectRoot, ['rev-parse', '--show-toplevel']));
  const projectPath = projectPathFromGitRoot(gitRoot, projectRoot);
  const lefthookName = lefthookFiles.find((name) => fs.existsSync(path.join(gitRoot, name)));
  if (mode !== 'off' && lefthookName) return { message: lefthookInstructions(lefthookName, mode, projectPath) };
  const filename = hookFilename(gitRoot);
  const resolvedRoot = realTarget(gitRoot);
  const resolvedHook = realTarget(filename);
  const relHook = path.relative(resolvedRoot, resolvedHook);
  if (!relHook || relHook === '..' || relHook.startsWith('..' + path.sep) || path.isAbsolute(relHook)) {
    throw new Error(`Refusing to write git hook outside repository root: ${filename}`);
  }
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

export { installHook };
