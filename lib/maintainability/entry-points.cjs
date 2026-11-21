'use strict';

const path = require('node:path');
const ts = require('typescript');
const { localDockerBuild, dockerNodeEntry } = require('./docker-entry-points.cjs');
const { htmlScriptEntries, maxHtmlEntryBytes } = require('./html-entry-points.cjs');
const { operatorReferences } = require('./operator-references.cjs');
const { testSourcePattern } = require('./snapshot-context.cjs');
const { workflowNodeEntries } = require('./workflow-entry-points.cjs');

const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const builtExtensions = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'], '.jsx': ['.tsx'] };
const outputFolders = new Set(['dist', 'build', 'lib', 'out']);
const commandSeparators = /[\s'"=]+/;
const routeFrameworks = /^(?:next|nuxt|@remix-run\/.+|react-router|@react-router\/.+|@sveltejs\/kit|astro|gatsby)$/;

// Files that tools, frameworks or people run directly, or that are discovered by folder or file name instead of an import.
const conventionalFolder =
  /(?:^|\/)(?:__tests__|__mocks__|tests?|e2e|cypress|playwright|\.storybook|scripts?|bin|[\w-]*migrations?[\w-]*|seeds?|seeders?|prisma|pages|routes|examples?|docs|benchmarks?|fixtures)\//i;
const conventionalName =
  /(?:[.-](?:config|entity|migration|subscriber|seed|seeder|stories|story)\.[cm]?[jt]sx?$|(?:^|\/)\.?[\w-]*rc\.[cm]?[jt]s$|(?:^|\/)\d{10,}[\w-]*\.[jt]s$|(?:^|\/)(?:gulpfile|gruntfile|main|middleware|instrumentation)\.[cm]?[jt]sx?$|(?:^|\/)(?:jest|vitest)\.setup|(?:^|\/)app\/(?:entry\.client|entry\.server|root|routes)\.[cm]?[jt]sx?$)/i;
const packageRootEntry = /^(?:src\/)?(?:index|server|app|worker|cli|handler)\.[cm]?[jt]sx?$/;
const githubWorkflow = /^\.github\/workflows\/[^/]+\.ya?ml$/;

function readConfig(root, file) {
  const absolute = path.join(root, file);
  const text = ts.sys.readFile(absolute);
  if (text === undefined) return {};
  return ts.parseConfigFileTextToJson(absolute, text).config ?? {};
}

function stringValues(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringValues);
  return [];
}

// Words of shell commands that look like a file or a path, such as `node dist/main.js` or `--entryFile queue/worker`.
function commandPaths(commands) {
  return commands
    .flatMap((command) => command.split(commandSeparators))
    .filter((word) => /\.[cm]?[jt]sx?$/.test(word) || word.includes('/'));
}

function packageEntryPaths(manifest) {
  const scriptTokens = commandPaths(stringValues(manifest.scripts));
  return [
    ...stringValues([manifest.main, manifest.module, manifest.browser, manifest.bin, manifest.exports]),
    ...scriptTokens,
  ];
}

function nestEntryPaths(config) {
  const projects = Object.values(config.projects ?? {});
  return [config, ...projects].map(
    (project) => `${project.sourceRoot ?? (project === config ? 'src' : project.root)}/${project.entryFile ?? 'main'}`,
  );
}

// Node substitutes the same captured subpath for every star on the right side of an exports map.
function exportTargetMatcher(pattern) {
  const parts = pattern.split('*');
  const stars = parts.length - 1;
  const literalLength = pattern.length - stars;
  return (stem) => {
    const width = (stem.length - literalLength) / stars;
    if (width < 0 || !Number.isInteger(width) || !stem.startsWith(parts[0]) || !stem.endsWith(parts.at(-1)))
      return false;
    if (stars === 1) return true;
    const capture = stem.slice(parts[0].length, parts[0].length + width);
    return parts.join(capture) === stem;
  };
}

function addWildcardEntry(directory, entry, known, explicit) {
  const relative = path.posix.normalize(entry.replaceAll('\\', '/'));
  const extension = sourceExtensions.find((candidate) => relative.endsWith(candidate));
  const pattern = extension ? relative.slice(0, -extension.length) : relative;
  const [first, ...rest] = pattern.split('/');
  const candidates = [pattern, `src/${pattern}`];
  if (outputFolders.has(first)) candidates.push(['src', ...rest].join('/'));
  const matches = candidates.map((candidate) => exportTargetMatcher(path.posix.join(directory, candidate)));
  for (const file of known) {
    const stem = file.slice(0, -path.posix.extname(file).length);
    if (matches.some((match) => match(stem))) explicit.add(file);
  }
}

// `inventory` is every project-relative file; `sourceFiles` the analysed ones. Configuration files are read from disk.
function createEntryPoints(root, inventory, sourceFiles) {
  const known = new Set(sourceFiles);
  const explicit = new Set();
  const packageDirectories = new Map();
  const privateApplications = new Set();
  const workspacePackages = new Map();

  function addEntry(directory, entry) {
    if (entry.includes('*')) return;
    const relative = path.posix.normalize(entry.replaceAll('\\', '/'));
    const extension = path.posix.extname(relative);
    const stem = sourceExtensions.includes(extension) ? relative.slice(0, -extension.length) : relative;
    const [firstSegment, ...rest] = stem.split('/');
    // Build output such as dist/main.js comes from src/main.ts, and tools accept paths relative to src.
    const stems = [stem, `src/${stem}`];
    if (outputFolders.has(firstSegment)) stems.push(['src', ...rest].join('/'));
    const extensions = [...(builtExtensions[extension] ?? []), ...sourceExtensions];
    const candidates = [relative];
    for (const base of stems) {
      for (const candidateExtension of extensions)
        candidates.push(base + candidateExtension, `${base}/index${candidateExtension}`);
    }
    for (const candidate of candidates) {
      const file = path.posix.join(directory, candidate);
      if (known.has(file)) explicit.add(file);
    }
  }

  const inventoryFiles = new Set(inventory);
  function addManifest(directory, file) {
    const manifest = readConfig(root, file);
    if (
      manifest.private === true &&
      !['main', 'module', 'browser', 'bin', 'exports', 'types', 'typings', 'typesVersions'].some(
        (key) => key in manifest,
      )
    )
      privateApplications.add(directory);
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies };
    if (typeof manifest.name === 'string' && directory !== '.') workspacePackages.set(manifest.name, directory);
    packageDirectories.set(
      directory,
      Object.keys(dependencies).some((dependency) => routeFrameworks.test(dependency)),
    );
    for (const entry of packageEntryPaths(manifest)) addEntry(directory, entry);
    for (const script of Object.values(manifest.scripts ?? {})) {
      if (typeof script !== 'string') continue;
      const build = localDockerBuild(script, directory);
      if (!build || !inventoryFiles.has(build.dockerfile)) continue;
      const entry = dockerNodeEntry(ts.sys.readFile(path.join(root, build.dockerfile)), build.contextDirectory, known);
      if (entry) explicit.add(entry);
    }
    for (const entry of stringValues(manifest.exports))
      if (entry.includes('*')) addWildcardEntry(directory, entry, known, explicit);
  }

  function addKnownEntry(file) {
    if (known.has(file)) explicit.add(file);
  }

  function addHtmlScripts(file, directory) {
    const absolute = path.join(root, file);
    const size = ts.sys.getFileSize(absolute);
    if (!size || size > maxHtmlEntryBytes) return;
    for (const src of htmlScriptEntries(ts.sys.readFile(absolute))) {
      addKnownEntry(path.posix.join(directory, src));
    }
  }

  for (const file of inventory) {
    const directory = path.posix.dirname(file);
    const name = path.posix.basename(file);
    if (name === 'package.json') {
      addManifest(directory, file);
    } else if (name === 'project.json') {
      for (const entry of commandPaths(stringValues(readConfig(root, file)))) addEntry(directory, entry);
    } else if (name === 'nest-cli.json') {
      for (const entry of nestEntryPaths(readConfig(root, file))) addEntry(directory, entry);
    } else if (/^tsconfig(?:\..+)?\.json$/.test(name)) {
      for (const entry of readConfig(root, file).files ?? []) addEntry(directory, entry);
    } else if (githubWorkflow.test(file)) {
      for (const entry of workflowNodeEntries(ts.sys.readFile(path.join(root, file)))) addKnownEntry(entry);
    } else if (/\.html$/i.test(name)) {
      addHtmlScripts(file, directory);
    }
  }

  function nearestPackage(file) {
    for (let directory = path.posix.dirname(file); ; directory = path.posix.dirname(directory)) {
      if (packageDirectories.has(directory)) return directory;
      if (directory === '.') return '.';
    }
  }

  function packageRelative(file) {
    const packageDirectory = nearestPackage(file);
    return packageDirectory === '.' ? file : file.slice(packageDirectory.length + 1);
  }

  // Tests, scripts, configuration and migrations are run by tools, so what they load says nothing about the application.
  function isToolingFile(file) {
    // Files beside package.json are scripts run by hand, a Dockerfile or CI.
    return (
      testSourcePattern.test(file) ||
      conventionalFolder.test(file) ||
      conventionalName.test(file) ||
      !packageRelative(file).includes('/')
    );
  }

  function isEntryPoint(file) {
    if (explicit.has(file) || isToolingFile(file) || packageRootEntry.test(packageRelative(file))) return true;
    return /(?:^|\/)app\//.test(file) && packageDirectories.get(nearestPackage(file)) === true;
  }
  return {
    isEntryPoint,
    operatorScripts: operatorReferences(root, inventory, known),
    isToolingFile,
    workspacePackages,
    isPrivateApplication: (file) => privateApplications.has(nearestPackage(file)),
  };
}

module.exports = { createEntryPoints };
