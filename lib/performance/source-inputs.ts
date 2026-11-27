import fs from 'node:fs';
import path from 'node:path';
import type { Finding } from '../shared/types.js';
import { coveringConfig, isWithin } from '../shared/workspaces.js';

/**
 * One config to scan; `scope` is the folder whose files it reports, `companion` marks a jsconfig
 * that only adds files.
 */
interface ScanEntry {
  config: string;
  scope?: string;
  companion?: boolean;
  // A config file named on the command line is scanned exactly as it lists its files.
  explicit?: boolean;
}

function isSourceInput(filename: string): boolean {
  return /\.[cm]?[jt]sx?$/i.test(filename) && !/\.d\.[cm]?ts$/i.test(filename);
}

function compareFindings(left: Finding, right: Finding): number {
  return (
    (left.file ?? '').localeCompare(right.file ?? '') ||
    (left.line ?? 0) - (right.line ?? 0) ||
    (left.column ?? 0) - (right.column ?? 0) ||
    left.ruleId.localeCompare(right.ruleId)
  );
}

// A shared source can be a test callback under one config and a request handler under another.
function mergeFinding(byKey: Map<string, Finding>, key: string, finding: Finding): void {
  const existing = byKey.get(key);
  if (
    !existing ||
    (existing.contextualReason && (!finding.contextualReason || finding.contextualReason < existing.contextualReason))
  ) {
    byKey.set(key, finding);
  }
}

function resolveConfig(input: string): string {
  const absolute = path.resolve(input);
  const info = fs.statSync(absolute, { throwIfNoEntry: false });
  if (info?.isFile()) return absolute;
  if (!info?.isDirectory()) throw new Error('Project config does not exist: ' + input);
  for (const filename of ['tsconfig.json', 'jsconfig.json']) {
    const candidate = path.join(absolute, filename);
    if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
  }
  const ancestor = coveringConfig(absolute);
  if (ancestor) return ancestor;
  throw new Error('No tsconfig.json or jsconfig.json in ' + input + '. Pass source files explicitly.');
}

// The configs to scan for one `-p` input, each with the folder whose files it reports: the input
// folder, or the config's own folder. Files a config pulls in from outside that folder still load
// for types.
// A folder whose tsconfig.json leaves out the JavaScript a sibling jsconfig.json covers is scanned with both;
// `companion` marks the jsconfig, which only adds the files the tsconfig did not already scan.
function projectConfigs(input: string): ScanEntry[] {
  const config = resolveConfig(input);
  const isFolder = fs.statSync(path.resolve(input)).isDirectory();
  const scope = isFolder ? path.resolve(input) : path.dirname(config);
  const configs: ScanEntry[] = [{ config, scope, ...(!isFolder && { explicit: true }) }];
  const companion = companionOf(config);
  if (isFolder && companion) configs.push({ config: companion, scope, companion: true });
  return configs;
}

function companionOf(config: string): string | undefined {
  const jsconfig = path.join(path.dirname(config), 'jsconfig.json');
  return path.basename(config) === 'tsconfig.json' && fs.existsSync(jsconfig) ? jsconfig : undefined;
}

// A workspace package's tsconfig gets its sibling jsconfig as a companion too, keeping the
// workspace's cross-package scope.
function workspaceEntries(configs: string[]): ScanEntry[] {
  return configs.flatMap((input) => {
    const config = resolveConfig(input);
    const companion = companionOf(config);
    return companion ? [{ config }, { config: companion, companion: true }] : [{ config }];
  });
}

// `project` is one `-p` input, or the configs of the selected packages of a monorepo. Those report
// every file they
// include: the workspace root that was scanned contains them, and a file shared by two packages
// reports once.
function scanEntries(project: string | string[] | undefined): ScanEntry[] {
  if (Array.isArray(project)) return workspaceEntries(project);
  return projectConfigs(project ?? '.');
}

function isInScope(scope: string | undefined, filename: string): boolean {
  return !scope || isWithin(scope, filename);
}

// A finding names the file it sits in, which is not the scanned file when a rule follows a call
// into another one.
function relativeToWorkingDirectory(filename: string): string {
  return path.relative(process.cwd(), filename).split(path.sep).join('/');
}

export {
  compareFindings,
  isInScope,
  isSourceInput,
  mergeFinding,
  relativeToWorkingDirectory,
  resolveConfig,
  scanEntries,
};
