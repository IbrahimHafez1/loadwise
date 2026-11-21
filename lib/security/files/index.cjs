'use strict';

// The file-based security checks: `loadwise sec` runs them over the project folder next to the TypeScript analysis.
const fs = require('node:fs');
const path = require('node:path');
const { listProjectFiles, searchTrackedText, isEnvFileName } = require('./project-files.cjs');
const { checkSecrets, tokenSearchPattern } = require('./secrets.cjs');
const { checkDockerfile, isDockerfile } = require('./dockerfile.cjs');
const { checkCompose, isComposeFile } = require('./compose.cjs');
const { isTestSource, testSourceReason } = require('../file-context.cjs');
const { reviewedReason } = require('./review-directive.cjs');
const examples = require('../examples/files.cjs');

const maxFileBytes = 1 << 20;
const binarySniffBytes = 8000;
const skippedExtensions = new Set(
  '.png .jpg .jpeg .gif .webp .ico .pdf .zip .gz .tgz .woff .woff2 .ttf .eot .mp3 .mp4 .wasm .map .lock .svg'.split(
    ' ',
  ),
);
const skippedNamePattern = /\.min\./i;
const skippedNames = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
const exampleLanguages = { 'committed-secret': 'dotenv', 'compose-hardcoded-secret': 'yaml' };

function readText(absolute) {
  const stat = fs.statSync(absolute, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > maxFileBytes) return undefined;
  const buffer = fs.readFileSync(absolute);
  return buffer.subarray(0, binarySniffBytes).includes(0) ? undefined : buffer.toString('utf8');
}

function findingsFor(file, text) {
  return [
    ...checkSecrets(file, text),
    ...(isDockerfile(file) ? checkDockerfile(file, text) : []),
    ...(isComposeFile(file) ? checkCompose(text) : []),
  ];
}

function completeFinding(file, finding, lines) {
  const [code, note] = examples[finding.ruleId];
  const contextualReason =
    reviewedReason(lines, finding.line, finding.ruleId) ??
    finding.contextualReason ??
    (isTestSource(file) ? testSourceReason : undefined);
  return {
    file,
    ...finding,
    ...(contextualReason && { contextualReason }),
    example: { language: exampleLanguages[finding.ruleId] ?? 'dockerfile', code, note },
  };
}

function isNamedConfigFile(absolute) {
  const baseName = path.basename(absolute);
  return isEnvFileName(baseName) || isDockerfile(baseName) || isComposeFile(baseName);
}

function isSkippedFile(absolute) {
  const baseName = path.basename(absolute);
  return (
    skippedNames.has(baseName) ||
    skippedNamePattern.test(baseName) ||
    skippedExtensions.has(path.extname(baseName).toLowerCase()) ||
    absolute.split(path.sep).includes('node_modules')
  );
}

// In git only the config files and the files git's search found a token in are opened; outside git every file is.
function filesToRead(root, isChangedFile) {
  const { files, tracked, topLevelFiles } = listProjectFiles(root);
  const topLevelConfig = topLevelFiles.filter(isNamedConfigFile);
  if (isChangedFile) {
    // A changed-file scan already has a small candidate set and needs no repository-wide token search.
    return [...files, ...topLevelConfig].filter((file) => isChangedFile(file) && !isSkippedFile(file));
  }
  if (!tracked) return files.filter((absolute) => !isSkippedFile(absolute));
  const withTokens = searchTrackedText(root, tokenSearchPattern) ?? new Set();
  const projectFiles = files.filter((absolute) => isNamedConfigFile(absolute) || withTokens.has(absolute));
  return [...new Set([...projectFiles, ...topLevelConfig])].filter((absolute) => !isSkippedFile(absolute));
}

function hasInfrastructureFiles(root) {
  const { files, topLevelFiles } = listProjectFiles(root);
  return [...files, ...topLevelFiles].some((file) => isNamedConfigFile(file) && !isSkippedFile(file));
}

// Selected workspaces can share repository-level configuration files.
function scanProjectFiles(roots, isChangedFile) {
  const findings = [];
  let scannedFiles = 0;
  const files = new Set(roots.flatMap((root) => filesToRead(root, isChangedFile)));
  for (const absolute of files) {
    const text = readText(absolute);
    if (text === undefined) continue;
    scannedFiles++;
    const file = path.relative(process.cwd(), absolute).split(path.sep).join('/');
    const lines = text.split(/\r?\n/);
    for (const finding of findingsFor(file, text)) findings.push(completeFinding(file, finding, lines));
  }
  findings.sort((first, second) => first.file.localeCompare(second.file) || first.line - second.line);
  return { scannedFiles, findings };
}

module.exports = { hasInfrastructureFiles, scanProjectFiles };
