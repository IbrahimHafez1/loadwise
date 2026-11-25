// The file-based security checks: `loadwise sec` runs them over the project folder next to the
// TypeScript analysis.
import fs from 'node:fs';
import path from 'node:path';
import { listProjectFiles, searchTrackedText, isEnvFileName } from './project-files.js';
import { checkSecrets, tokenSearchPattern } from './secrets.js';
import { checkDockerfile, isDockerfile } from './dockerfile.js';
import { checkCompose, isComposeFile } from './compose.js';
import { isTestSource, testSourceReason } from '../file-context.js';
import { fileReviewReason } from './review-directive.js';
import examplesModule from '../examples/files.cjs';
const examples: Record<string, readonly [string, string]> = examplesModule.default;
import type { ScanResult } from '../../shared/types.js';
import type { FileFinding } from '../types/file-finding.js';
import type { PathPredicate } from '../types/project-files.js';

const maxFileBytes = 1 << 20;
const binarySniffBytes = 8000;
const skippedExtensions = new Set(
  '.png .jpg .jpeg .gif .webp .ico .pdf .zip .gz .tgz .woff .woff2 .ttf .eot .mp3 .mp4 .wasm .map .lock .svg'.split(
    ' ',
  ),
);
const skippedNamePattern = /\.min\./i;
const skippedNames = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
const exampleLanguages: Record<string, string> = { 'committed-secret': 'dotenv', 'compose-hardcoded-secret': 'yaml' };

function readText(absolute: string) {
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > maxFileBytes) return undefined;
  const buffer = fs.readFileSync(absolute);
  return buffer.subarray(0, binarySniffBytes).includes(0) ? undefined : buffer.toString('utf8');
}

function findingsFor(file: string, text: string): FileFinding[] {
  return [
    ...checkSecrets(file, text),
    ...(isDockerfile(file) ? checkDockerfile(file, text) : []),
    ...(isComposeFile(file) ? checkCompose(text) : []),
  ];
}

function completeFinding(file: string, finding: FileFinding, reviewedReason: string | undefined) {
  const [code, note] = examples[finding.ruleId];
  const contextualReason =
    reviewedReason ?? finding.contextualReason ?? (isTestSource(file) ? testSourceReason : undefined);
  return {
    file,
    ...finding,
    ...(contextualReason && { contextualReason }),
    example: { language: exampleLanguages[finding.ruleId] ?? 'dockerfile', code, note },
  };
}

function isNamedConfigFile(absolute: string) {
  const baseName = path.basename(absolute);
  return isEnvFileName(baseName) || isDockerfile(baseName) || isComposeFile(baseName);
}

function isSkippedFile(absolute: string) {
  const baseName = path.basename(absolute);
  return (
    skippedNames.has(baseName) ||
    skippedNamePattern.test(baseName) ||
    skippedExtensions.has(path.extname(baseName).toLowerCase()) ||
    absolute.split(path.sep).includes('node_modules')
  );
}

// In git only the config files and the files git's search found a token in are opened; outside git
// every file is.
function filesToRead(root: string, isChangedFile?: PathPredicate, isIgnored?: PathPredicate) {
  const { files, tracked, topLevelFiles, exclusions } = listProjectFiles(root, isIgnored);
  const topLevelConfig = topLevelFiles.filter(isNamedConfigFile);
  if (isChangedFile) {
    // A changed-file scan already has a small candidate set and needs no repository-wide token
    // search.
    return [...files, ...topLevelConfig].filter((file) => isChangedFile(file) && !isSkippedFile(file));
  }
  if (!tracked) return files.filter((absolute) => !isSkippedFile(absolute));
  if (!files.length) return topLevelConfig.filter((file) => !isSkippedFile(file));
  const withTokens = searchTrackedText(root, tokenSearchPattern, exclusions);
  // A failed prefilter gives no information about the files it would have matched.
  const projectFiles = withTokens
    ? files.filter((absolute) => isNamedConfigFile(absolute) || withTokens.has(absolute))
    : files;
  return [...new Set([...projectFiles, ...topLevelConfig])].filter((absolute) => !isSkippedFile(absolute));
}

function hasInfrastructureFiles(root: string) {
  const { files, topLevelFiles } = listProjectFiles(root);
  return [...files, ...topLevelFiles].some((file) => isNamedConfigFile(file) && !isSkippedFile(file));
}

// Selected workspaces can share repository-level configuration files.
function scanProjectFiles(
  roots: readonly string[],
  isChangedFile?: PathPredicate,
  isIgnored?: PathPredicate,
): ScanResult {
  const findings: ReturnType<typeof completeFinding>[] = [];
  let scannedFiles = 0;
  const files = new Set(roots.flatMap((root: string) => filesToRead(root, isChangedFile, isIgnored)));
  for (const absolute of files) {
    const text = readText(absolute);
    if (text === undefined) continue;
    scannedFiles++;
    const file = path.relative(process.cwd(), absolute).split(path.sep).join('/');
    const fileFindings = findingsFor(file, text);
    if (!fileFindings.length) continue;
    const review = fileReviewReason(file, text);
    for (const finding of fileFindings) findings.push(completeFinding(file, finding, review?.(finding)));
  }
  findings.sort((first, second) => first.file.localeCompare(second.file) || first.line - second.line);
  return { scannedFiles, findings };
}

export { hasInfrastructureFiles, scanProjectFiles };
