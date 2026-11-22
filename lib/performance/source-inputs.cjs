'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isSourceInput(filename) {
  return /\.[cm]?[jt]sx?$/i.test(filename) && !/\.d\.[cm]?ts$/i.test(filename);
}

function compareFindings(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.column - right.column ||
    left.ruleId.localeCompare(right.ruleId)
  );
}

// A shared source can be a test callback under one config and a request handler under another.
function mergeFinding(byKey, key, finding) {
  const existing = byKey.get(key);
  if (
    !existing ||
    (existing.contextualReason && (!finding.contextualReason || finding.contextualReason < existing.contextualReason))
  ) {
    byKey.set(key, finding);
  }
}

function resolveConfig(input) {
  const absolute = path.resolve(input);
  const info = fs.statSync(absolute, { throwIfNoEntry: false });
  if (info?.isFile()) return absolute;
  if (!info?.isDirectory()) throw new Error('Project config does not exist: ' + input);
  for (const filename of ['tsconfig.json', 'jsconfig.json']) {
    const candidate = path.join(absolute, filename);
    if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
  }
  const ancestor = require('../shared/workspaces.cjs').coveringConfig(absolute);
  if (ancestor) return ancestor;
  throw new Error('No tsconfig.json or jsconfig.json in ' + input + '. Pass source files explicitly.');
}

// The configs to scan for one `-p` input, each with the folder whose files it reports: the input folder, or the
// config's own folder. Files a config pulls in from outside that folder still load for types.
// A folder whose tsconfig.json leaves out the JavaScript a sibling jsconfig.json covers is scanned with both;
// `companion` marks the jsconfig, which only adds the files the tsconfig did not already scan.
function projectConfigs(input) {
  const config = resolveConfig(input);
  const isFolder = fs.statSync(path.resolve(input)).isDirectory();
  const scope = isFolder ? path.resolve(input) : path.dirname(config);
  const configs = [{ config, scope }];
  const jsconfig = path.join(path.dirname(config), 'jsconfig.json');
  if (isFolder && path.basename(config) === 'tsconfig.json' && fs.existsSync(jsconfig)) {
    configs.push({ config: jsconfig, scope, companion: true });
  }
  return configs;
}

// `project` is one `-p` input, or the configs of the selected packages of a monorepo. Those report every file they
// include: the workspace root that was scanned contains them, and a file shared by two packages reports once.
function scanEntries(project) {
  if (Array.isArray(project)) return project.map((config) => ({ config: resolveConfig(config) }));
  return projectConfigs(project ?? '.');
}

function isInScope(scope, filename) {
  return !scope || require('../shared/workspaces.cjs').isWithin(scope, filename);
}

// A finding names the file it sits in, which is not the scanned file when a rule follows a call into another one.
function relativeToWorkingDirectory(filename) {
  return path.relative(process.cwd(), filename).split(path.sep).join('/');
}

module.exports = {
  compareFindings,
  isInScope,
  isSourceInput,
  mergeFinding,
  relativeToWorkingDirectory,
  resolveConfig,
  scanEntries,
};
