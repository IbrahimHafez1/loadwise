'use strict';

// Finds the packages of a monorepo and the TypeScript config each one analyses with. Supports npm/yarn
// `workspaces` (array or { packages }), pnpm-workspace.yaml and lerna.json, with the `*` and `**` glob subset.
const fs = require('node:fs');
const path = require('node:path');

const projectConfigs = ['tsconfig.json', 'jsconfig.json'];

function readText(filename) {
  try {
    return fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return undefined;
  }
}

function readJson(filename) {
  const text = readText(filename);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isFile(filename) {
  return fs.statSync(filename, { throwIfNoEntry: false })?.isFile() === true;
}

function projectConfig(directory) {
  return projectConfigs.map((name) => path.join(directory, name)).find(isFile);
}

// Only the `packages:` list of the file: a block of `- glob` lines, optionally quoted.
function pnpmPatterns(text) {
  const patterns = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    const content = line.replace(/\s#.*$/, '').trimEnd();
    if (!content.trim() || content.trim().startsWith('#')) continue;
    if (/^\S/.test(content)) {
      inPackages = /^packages\s*:\s*$/.test(content);
      continue;
    }
    const item = inPackages && /^\s*-\s+(.+)$/.exec(content);
    if (item) patterns.push(item[1].trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  return patterns;
}

function workspacePatterns(root) {
  const manifest = readJson(path.join(root, 'package.json'));
  const declared = manifest?.workspaces;
  const fromManifest = Array.isArray(declared) ? declared : declared?.packages;
  if (Array.isArray(fromManifest)) return fromManifest;
  const pnpmText = readText(path.join(root, 'pnpm-workspace.yaml'));
  if (pnpmText !== undefined) return pnpmPatterns(pnpmText);
  const lerna = readJson(path.join(root, 'lerna.json'));
  return Array.isArray(lerna?.packages) ? lerna.packages : [];
}

function subdirectories(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
}

function segmentMatcher(segment) {
  const source = segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${source}$`);
}

// Directories under `directory` matching the remaining glob segments; `**` spans zero or more levels.
function matchSegments(directory, segments, matches) {
  if (!segments.length) {
    matches.add(directory);
    return;
  }
  const [segment, ...rest] = segments;
  if (segment === '**') {
    matchSegments(directory, rest, matches);
    for (const name of subdirectories(directory)) matchSegments(path.join(directory, name), segments, matches);
    return;
  }
  if (!/[*?]/.test(segment)) {
    const next = path.join(directory, segment);
    if (fs.statSync(next, { throwIfNoEntry: false })?.isDirectory()) matchSegments(next, rest, matches);
    return;
  }
  const matcher = segmentMatcher(segment);
  for (const name of subdirectories(directory))
    if (matcher.test(name)) matchSegments(path.join(directory, name), rest, matches);
}

function expandPattern(root, pattern) {
  const segments = pattern
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter((segment) => segment && segment !== '.');
  const matches = new Set();
  matchSegments(root, segments, matches);
  return matches;
}

function packageDirectories(root, patterns) {
  const included = new Set();
  for (const pattern of patterns.filter((entry) => !entry.startsWith('!'))) {
    for (const directory of expandPattern(root, pattern)) included.add(directory);
  }
  for (const pattern of patterns.filter((entry) => entry.startsWith('!'))) {
    for (const directory of expandPattern(root, pattern.slice(1))) included.delete(directory);
  }
  included.delete(root);
  return [...included].filter((directory) => isFile(path.join(directory, 'package.json'))).sort();
}

// { packages: [{ name, directory, config }], withoutConfig: [{ name, directory }] } for a monorepo root;
// both lists are empty when the root declares no workspaces.
function discoverWorkspaces(root) {
  const packages = [];
  const withoutConfig = [];
  for (const directory of packageDirectories(root, workspacePatterns(root))) {
    const name = readJson(path.join(directory, 'package.json'))?.name ?? path.relative(root, directory);
    const config = projectConfig(directory);
    if (config) packages.push({ name, directory, config });
    else withoutConfig.push({ name, directory });
  }
  return { packages, withoutConfig };
}

// A selector is a package name or a path to its folder, relative to the working directory or to the root.
function selectWorkspaces(packages, root, selectors) {
  if (!selectors.length) return packages;
  const chosen = new Set();
  for (const selector of selectors) {
    const candidates = new Set([path.resolve(selector), path.resolve(root, selector)]);
    const matched = packages.filter(({ name, directory }) => name === selector || candidates.has(directory));
    if (!matched.length) {
      throw new Error(`--workspace ${selector} matches no package with a tsconfig.json or jsconfig.json.`);
    }
    for (const entry of matched) chosen.add(entry);
  }
  return packages.filter((entry) => chosen.has(entry));
}

module.exports = { discoverWorkspaces, projectConfig, selectWorkspaces };
