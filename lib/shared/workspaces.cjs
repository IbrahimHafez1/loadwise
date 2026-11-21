'use strict';

// Finds the packages of a monorepo and the TypeScript config each one analyses with. Supports npm/yarn
// `workspaces` (array or { packages }), pnpm-workspace.yaml and lerna.json, with the globs of lib/shared/glob.cjs.
const fs = require('node:fs');
const path = require('node:path');
const { globExpression } = require('./glob.cjs');

const projectConfigs = ['tsconfig.json', 'jsconfig.json'];

function readText(filename) {
  try {
    return fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function readJson(filename) {
  const text = readText(filename);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON in ' + filename);
  }
}

function isFile(filename) {
  return fs.statSync(filename, { throwIfNoEntry: false })?.isFile() === true;
}

async function isProjectDirectory(filename) {
  try {
    return (await fs.promises.stat(filename)).isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function projectConfig(directory) {
  return projectConfigs.map((name) => path.join(directory, name)).find(isFile);
}

// Only the `packages:` list of the file: a block of `- glob` lines, optionally quoted.
function pnpmPatterns(text, filename) {
  const patterns = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    const content = line.replace(/\s#.*$/, '').trimEnd();
    if (!content.trim() || content.trim().startsWith('#')) continue;
    const item = inPackages && /^\s*-\s+(.+)$/.exec(content);
    if (item) {
      patterns.push(item[1].trim().replace(/^(['"])(.*)\1$/, '$2'));
    } else if (/^\S/.test(content)) {
      inPackages = /^packages\s*:\s*$/.test(content);
      if (!inPackages && /^packages\s*:/.test(content) && !/^packages\s*:\s*\[\s*\]$/.test(content)) {
        throw new Error(
          `Unsupported packages list in ${filename}. Put each workspace glob on its own "- pattern" line under "packages:".`,
        );
      }
    }
  }
  return patterns;
}

function patternList(patterns, field, filename) {
  if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== 'string' || !pattern.trim())) {
    throw new Error(`${field} in ${filename} must be an array of non-empty strings.`);
  }
  return patterns;
}

function workspacePatterns(root) {
  const manifestFile = path.join(root, 'package.json');
  const manifest = readJson(manifestFile);
  const declared = manifest?.workspaces;
  const fromManifest = Array.isArray(declared) ? declared : declared?.packages;
  if (declared !== undefined) return patternList(fromManifest, 'workspaces', manifestFile);
  const pnpmFile = path.join(root, 'pnpm-workspace.yaml');
  const pnpmText = readText(pnpmFile);
  if (pnpmText !== undefined) return pnpmPatterns(pnpmText, pnpmFile);
  const lernaFile = path.join(root, 'lerna.json');
  const lerna = readJson(lernaFile);
  return lerna?.packages === undefined ? [] : patternList(lerna.packages, 'packages', lernaFile);
}

function subdirectories(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
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
  if (!/[*?{]/.test(segment)) {
    const next = path.join(directory, segment);
    if (fs.statSync(next, { throwIfNoEntry: false })?.isDirectory()) matchSegments(next, rest, matches);
    return;
  }
  const matcher = globExpression(segment);
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
function selectWorkspaces(packages, root, selectors, caller = process.cwd()) {
  if (!selectors.length) return packages;
  const chosen = new Set();
  for (const selector of selectors) {
    const candidates = new Set([path.resolve(caller, selector), path.resolve(root, selector)]);
    const matched = packages.filter(({ name, directory }) => name === selector || candidates.has(directory));
    if (!matched.length) {
      throw new Error(`--workspace ${selector} matches no workspace package.`);
    }
    for (const entry of matched) chosen.add(entry);
  }
  return packages.filter((entry) => chosen.has(entry));
}

// Configless Node packages can use the explicit-JavaScript compiler options. Keep mixed-language
// projects and workspace roots on the config-based path so an incomplete scan cannot authorize fixes.
function plainJavaScriptSources(directory) {
  if (!isFile(path.join(directory, 'package.json')) || projectConfig(directory) || workspacePatterns(directory).length)
    return undefined;
  const files = require('../maintainability/inputs.cjs').listFiles(directory);
  if (files.some((file) => /\.[cm]?tsx?$/i.test(file) && !/\.d\.[cm]?ts$/i.test(file))) return undefined;
  const sources = files.filter((file) => /\.[cm]?jsx?$/i.test(file)).map((file) => path.join(directory, file));
  return sources.length ? sources : undefined;
}

module.exports = { discoverWorkspaces, projectConfig, selectWorkspaces, plainJavaScriptSources, isProjectDirectory };
