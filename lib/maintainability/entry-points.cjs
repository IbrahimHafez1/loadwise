'use strict';

const path = require('node:path');
const ts = require('typescript');
const { testSourcePattern } = require('./snapshot-context.cjs');

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

// `inventory` is every project-relative file; `sourceFiles` the analysed ones. Configuration files are read from disk.
function createEntryPoints(root, inventory, sourceFiles) {
  const known = new Set(sourceFiles);
  const explicit = new Set();
  const packageDirectories = new Map();
  const workspacePackages = new Map();

  function addEntry(directory, entry) {
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

  for (const file of inventory) {
    const directory = path.posix.dirname(file);
    const name = path.posix.basename(file);
    if (name === 'package.json') {
      const manifest = readConfig(root, file);
      const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies };
      if (typeof manifest.name === 'string' && directory !== '.') workspacePackages.set(manifest.name, directory);
      packageDirectories.set(
        directory,
        Object.keys(dependencies).some((dependency) => routeFrameworks.test(dependency)),
      );
      for (const entry of packageEntryPaths(manifest)) addEntry(directory, entry);
    } else if (name === 'project.json') {
      for (const entry of commandPaths(stringValues(readConfig(root, file)))) addEntry(directory, entry);
    } else if (name === 'nest-cli.json') {
      for (const entry of nestEntryPaths(readConfig(root, file))) addEntry(directory, entry);
    } else if (/^tsconfig(?:\..+)?\.json$/.test(name)) {
      for (const entry of readConfig(root, file).files ?? []) addEntry(directory, entry);
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
  return { isEntryPoint, isToolingFile, workspacePackages };
}

module.exports = { createEntryPoints };
