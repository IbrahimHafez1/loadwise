'use strict';

// The file-based security checks: `loadwise sec` runs them over the project folder next to the TypeScript analysis.
const fs = require('node:fs');
const path = require('node:path');
const { listProjectFiles } = require('./project-files.cjs');
const { checkSecrets } = require('./secrets.cjs');
const { checkDockerfile, isDockerfile } = require('./dockerfile.cjs');
const { checkCompose, isComposeFile } = require('./compose.cjs');
const { isTestSource, testSourceReason } = require('../file-context.cjs');
const examples = require('../examples/files.cjs');

const maxFileBytes = 1 << 20;
const binarySniffBytes = 8000;
const skippedExtensions = new Set(
  '.png .jpg .jpeg .gif .webp .ico .pdf .zip .gz .tgz .woff .woff2 .ttf .eot .mp3 .mp4 .wasm .map .lock .svg'.split(
    ' ',
  ),
);
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

function completeFinding(file, finding) {
  const [code, note] = examples[finding.ruleId];
  const contextualReason = finding.contextualReason ?? (isTestSource(file) ? testSourceReason : undefined);
  return {
    file,
    ...finding,
    ...(contextualReason && { contextualReason }),
    example: { language: exampleLanguages[finding.ruleId] ?? 'dockerfile', code, note },
  };
}

// Findings for the project at `root`, with file paths relative to the working directory like the other checkers.
function scanProjectFiles(root) {
  const findings = [];
  for (const absolute of listProjectFiles(root).files) {
    const baseName = path.basename(absolute);
    if (skippedNames.has(baseName) || skippedExtensions.has(path.extname(baseName).toLowerCase())) continue;
    if (absolute.split(path.sep).includes('node_modules')) continue;
    const text = readText(absolute);
    if (text === undefined) continue;
    const file = path.relative(process.cwd(), absolute).split(path.sep).join('/');
    for (const finding of findingsFor(file, text)) findings.push(completeFinding(file, finding));
  }
  return findings.sort((first, second) => first.file.localeCompare(second.file) || first.line - second.line);
}

module.exports = { scanProjectFiles };
