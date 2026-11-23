'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { localDockerBuild, dockerNodeEntry } = require('./docker-entry-points.cjs');
const { noteUnreadable } = require('../shared/coverage-notes.cjs');
const { configFile, jsonConfigFile, configFilePaths, jsonConfigFilePaths } = require('./config-entry-points.cjs');
const { htmlScriptEntries, maxHtmlEntryBytes } = require('./html-entry-points.cjs');
const { operatorReferences } = require('./operator-references.cjs');
const { runtimeDirectories, isInside } = require('./runtime-directories.cjs');
const { testSourcePattern } = require('./snapshot-context.cjs');
const { walkNodes } = require('./walk.cjs');
const { workflowNodeEntries } = require('./workflow-entry-points.cjs');
const { maxConsumerBytes, placeholderMaxBytes } = require('./source-facts.cjs');
const { collectModuleUsage } = require('./module-usage.cjs');

const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const builtExtensions = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'], '.jsx': ['.tsx'] };
const outputFolders = new Set(['dist', 'build', 'lib', 'out']);
const commandSeparators = /[\s'"=]+/;
const routeFrameworks = /^(?:next|nuxt|@remix-run\/.+|react-router|@react-router\/.+|@sveltejs\/kit|astro|gatsby)$/;

// Files that tools, frameworks or people run directly, or that are discovered by folder or file name instead of an import.
const conventionalFolder =
  /(?:^|\/)(?:__tests__|__mocks__|tests?|e2e|cypress|playwright|\.storybook|scripts?|bin|[\w-]*migrations?[\w-]*|seeds?|seeders?|prisma|pages|routes|examples?|docs|benchmarks?|fixtures|public|static)\//i;
const conventionalName =
  /(?:[.-](?:config|entity|migration|subscriber|seed|seeder|stories|story|global-?setup)\.[cm]?[jt]sx?$|(?:^|\/)\.?[\w-]*rc\.[cm]?[jt]s$|(?:^|\/)\d{10,}[\w-]*\.[jt]s$|(?:^|\/)(?:gulpfile|gruntfile|main|middleware|instrumentation|global-?setup)\.[cm]?[jt]sx?$|(?:^|\/)(?:jest|vitest)\.(?:setup|global-?setup)|(?:^|\/)app\/(?:entry\.client|entry\.server|root|routes)\.[cm]?[jt]sx?$)/i;
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

function parseScript(absolute) {
  const text = ts.sys.readFile(absolute);
  return text === undefined ? undefined : ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true);
}

function literalStrings(expression) {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isArrayLiteralExpression(expression))
    return expression.elements.every(ts.isStringLiteralLike) ? expression.elements.map((element) => element.text) : [];
  return [];
}

// `schema: './db/*.table.ts'` (a string, array or glob) in a drizzle config names files drizzle-kit loads.
function drizzleSchemaPaths(sourceFile) {
  const paths = [];
  walkNodes(sourceFile, (node) => {
    if (!ts.isPropertyAssignment(node) || !ts.isIdentifier(node.name) || node.name.text !== 'schema') return;
    paths.push(...literalStrings(ts.skipOuterExpressions(node.initializer)));
  });
  return paths;
}

const workingDirectoryCalls = /^(?:process\.cwd\(\)|__dirname)$/;

// `.sequelizerc` names the config, models, seeders and migrations with path.resolve('src/db/config.cjs'), relative to
// the folder sequelize-cli runs in.
function sequelizePaths(sourceFile) {
  const paths = [];
  walkNodes(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    if (!['resolve', 'join'].includes(node.expression.name.text)) return;
    const parts = node.arguments.filter((argument) => !workingDirectoryCalls.test(argument.getText(sourceFile)));
    if (parts.length && parts.every(ts.isStringLiteralLike))
      paths.push(path.posix.join(...parts.map((part) => part.text)));
  });
  return paths;
}

function globPattern(rawGlob) {
  const glob = rawGlob.replace(/(?:\*\*\/)+/g, '**/').replace(/\*{3,}/g, '**');
  let pattern = '';
  let insideBraces = false;
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index];
    if (glob.startsWith('**/', index)) {
      pattern += '(?:.*/)?';
      index += 2;
    } else if (glob.startsWith('**', index)) {
      pattern += '.*';
      index += 1;
    } else if (character === '*') pattern += '[^/]*';
    else if (character === '?') pattern += '[^/]';
    else if (character === '{' && !insideBraces && glob.indexOf('}', index + 1) !== -1) {
      insideBraces = true;
      pattern += '(?:';
    } else if (character === '}' && insideBraces) {
      insideBraces = false;
      pattern += ')';
    } else if (character === ',' && insideBraces) pattern += '|';
    else pattern += character.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  try {
    return new RegExp('^' + pattern + '$');
  } catch {
    return /$^/;
  }
}

// Folders from the scan root up to the first one holding package.json or .git, where tool configs usually live.
function configFolders(root) {
  const folders = [];
  for (let folder = path.resolve(root); ; folder = path.dirname(folder)) {
    folders.push(folder);
    const boundary = fs.existsSync(path.join(folder, 'package.json')) || fs.existsSync(path.join(folder, '.git'));
    if (boundary || path.dirname(folder) === folder) return folders;
  }
}

const sourceFilePattern = /\.[cm]?[jt]sx?$/;
const skippedFolders = new Set(['node_modules', 'dist', 'build', 'out', 'coverage']);

function readFolder(folder) {
  try {
    return fs.readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    // A missing folder is expected; one that exists but cannot be listed hides files that may use an export.
    noteUnreadable({ error, location: folder, consequence: 'skipped it when looking for entry points' });
    return [];
  }
}

function sourceFilesBelow(folder) {
  const files = [];
  const pending = [folder];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readFolder(current)) {
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && !skippedFolders.has(entry.name)) pending.push(absolute);
      else if (entry.isFile() && sourceFilePattern.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name))
        files.push(absolute);
    }
  }
  return files;
}

function workspaceGlobs(folder) {
  const manifest = readConfig(folder, 'package.json');
  const declared = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
  if (Array.isArray(declared)) return declared.filter((glob) => typeof glob === 'string');
  const pnpm = ts.sys.readFile(path.join(folder, 'pnpm-workspace.yaml'));
  // Only the indented lines under `packages:` list members; other keys hold lists too.
  const packagesBlock = pnpm?.match(/^packages:[^\S\n]*\r?\n((?:[ \t]+.*(?:\r?\n|$)|[ \t]*\r?\n)*)/m);
  if (!packagesBlock) return;
  return [...packagesBlock[1].matchAll(/^\s*-\s*['"]?([^'"#\s]+)['"]?/gm)].map((match) => match[1]);
}

// Member globs are shallow (apps/*, packages/**), so a bounded walk of folders is enough.
function matchingMemberFolders(folder, included) {
  const members = [];
  const pending = [''];
  while (pending.length) {
    const relative = pending.pop();
    if (relative.split('/').length > 3) continue;
    for (const entry of readFolder(path.join(folder, relative))) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || skippedFolders.has(entry.name)) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (included.some((pattern) => pattern.test(child))) members.push(path.join(folder, child));
      pending.push(child);
    }
  }
  return members;
}

// The ancestor monorepo that lists the scanned package as a member, with its other member folders.
function siblingWorkspaces(packageFolder) {
  for (let folder = path.dirname(packageFolder); path.dirname(folder) !== folder; folder = path.dirname(folder)) {
    const globs = workspaceGlobs(folder);
    if (!globs) {
      if (fs.existsSync(path.join(folder, '.git'))) return [];
      continue;
    }
    const included = globs.filter((glob) => !glob.startsWith('!')).map((glob) => globPattern(glob.replace(/\/$/, '')));
    const members = matchingMemberFolders(folder, included);
    const scanned = path.resolve(packageFolder);
    return members.includes(scanned) ? members.filter((member) => member !== scanned) : [];
  }
  return [];
}

// Folders that source code reads from by a computed file name or serves statically.
function collectRuntimeFolders(known, root, fileFacts) {
  const runtimeFolders = new Set();
  for (const file of known) {
    const facts = fileFacts?.get(file);
    if (facts) {
      for (const folder of facts.runtimeFolders) runtimeFolders.add(folder);
      continue;
    }
    const size = ts.sys.getFileSize?.(path.join(root, file)) ?? 0;
    if (!size || size > maxConsumerBytes) continue;
    for (const folder of runtimeDirectories(ts.sys.readFile(path.join(root, file)) ?? '')) runtimeFolders.add(folder);
  }
  return runtimeFolders;
}

// Deep imports such as `@acme/lib/client/download` from sibling workspace members, as subpaths of the package with
// the names they import. A subpath imported several times keeps every name, and `all` once any import uses the module.
function siblingImports(packageName, members) {
  const prefix = packageName + '/';
  const imports = new Map();
  for (const member of members) {
    for (const file of sourceFilesBelow(member)) recordFileSiblingImports(imports, file, prefix);
  }
  return imports;
}

function recordFileSiblingImports(imports, file, prefix) {
  if ((ts.sys.getFileSize?.(file) ?? 0) > maxConsumerBytes) return;
  const text = ts.sys.readFile(file);
  if (!text?.includes(prefix)) return;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  for (const { specifier, names } of collectModuleUsage(source, file, () => undefined).unresolved) {
    if (specifier.startsWith(prefix)) recordSiblingImport(imports, specifier.slice(prefix.length), names);
  }
}

function recordSiblingImport(imports, subpath, names) {
  const known = imports.get(subpath);
  if (known === 'all' || names === 'all') imports.set(subpath, 'all');
  else imports.set(subpath, [...new Set([...(known ?? []), ...names])]);
}

// An entry that an ancestor package.json declares relative to its own folder, such as `./dist/api/*.js`, as the
// path it takes from the scanned folder. The scanned `src` is what builds into that output folder.
function entryBelowScanRoot(entry, ancestorFolder, root) {
  const relative = path.posix.normalize(entry.replaceAll('\\', '/'));
  const scannedPrefix = path.relative(ancestorFolder, root).replaceAll('\\', '/') + '/';
  if (relative.startsWith(scannedPrefix)) return relative.slice(scannedPrefix.length);
  const [first, ...rest] = relative.split('/');
  if (outputFolders.has(first)) return rest.join('/');
}

// `inventory` is every project-relative file; `sourceFiles` the analysed ones. Configuration files are read from disk.
// `fileFacts` holds what the scan already learned from each analysed file, so those files are not read again.
function createEntryPoints(root, inventory, sourceFiles, fileFacts) {
  const known = new Set(sourceFiles);
  const explicit = new Set();
  const packageDirectories = new Map();
  const privateApplications = new Set();
  const workspacePackages = new Map();

  // The analysed files that a package entry such as `dist/main.js` or `queue/worker` can name.
  function entryFiles(directory, entry) {
    if (entry.includes('*')) return [];
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
    return candidates.map((candidate) => path.posix.join(directory, candidate)).filter((file) => known.has(file));
  }

  function addEntry(directory, entry) {
    for (const file of entryFiles(directory, entry)) explicit.add(file);
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
    // Mocha and Jest also read their options from package.json instead of a config file.
    for (const toolKey of ['mocha', 'jest'])
      for (const entry of jsonConfigFilePaths(manifest[toolKey] ?? {})) addConfigPath(directory, entry);
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

  function addConfigPath(directory, entry) {
    if (!/[*?{]/.test(entry)) return addEntry(directory, entry);
    const pattern = globPattern(path.posix.normalize(path.posix.join(directory, entry)));
    for (const file of known) if (pattern.test(file)) explicit.add(file);
  }

  function addConfigFiles(file, directory) {
    const paths = jsonConfigFile.test(file)
      ? jsonConfigFilePaths(readConfig(root, file))
      : configFilePaths(parseScript(path.join(root, file)) ?? ts.createSourceFile(file, '', ts.ScriptTarget.Latest));
    for (const entry of paths) addConfigPath(directory, entry);
  }

  function addEntries(directory, entries) {
    for (const entry of entries) addEntry(directory, entry);
  }

  function addSequelizeEntries(file, directory) {
    const sourceFile = parseScript(path.join(root, file));
    addEntries(directory, sourceFile ? sequelizePaths(sourceFile) : []);
  }

  // Each file kind names its entry points in its own way; the first kind that matches wins.
  function addFileEntries(file) {
    const directory = path.posix.dirname(file);
    const name = path.posix.basename(file);
    if (name === 'package.json') return addManifest(directory, file);
    if (name === 'project.json') return addEntries(directory, commandPaths(stringValues(readConfig(root, file))));
    if (name === 'nest-cli.json') return addEntries(directory, nestEntryPaths(readConfig(root, file)));
    if (/^tsconfig(?:\..+)?\.json$/.test(name)) return addEntries(directory, readConfig(root, file).files ?? []);
    if (githubWorkflow.test(file)) {
      for (const entry of workflowNodeEntries(ts.sys.readFile(path.join(root, file)))) addKnownEntry(entry);
      return;
    }
    if (configFile.test(file) || jsonConfigFile.test(file)) return addConfigFiles(file, directory);
    if (/\.html$/i.test(name)) return addHtmlScripts(file, directory);
    if (name === '.sequelizerc') addSequelizeEntries(file, directory);
  }
  for (const file of inventory) addFileEntries(file);

  // Folders that source code reads from by a computed file name or serves statically hold files nothing imports.
  const runtimeFolders = collectRuntimeFolders(known, root, fileFacts);
  for (const file of known) if ([...runtimeFolders].some((folder) => isInside(file, folder))) explicit.add(file);

  // Drizzle configs often sit above the scanned folder, at the package or repository root.
  function addPathOrGlob(configFolder, entry) {
    const relative = path.relative(root, path.resolve(configFolder, entry)).replaceAll('\\', '/');
    if (!relative || relative.startsWith('..')) return;
    if (/[*?{]/.test(entry)) {
      const pattern = globPattern(relative);
      for (const file of known) if (pattern.test(file)) explicit.add(file);
      return;
    }
    // A folder schema loads every file in it.
    addEntry('.', relative);
    for (const file of known) if (file.startsWith(relative + '/')) explicit.add(file);
  }
  function addDrizzleSchemas(folder) {
    for (const extension of ['.ts', '.js', '.mjs', '.cjs', '.mts', '.cts']) {
      const sourceFile = parseScript(path.join(folder, 'drizzle.config' + extension));
      for (const entry of sourceFile ? drizzleSchemaPaths(sourceFile) : []) addPathOrGlob(folder, entry);
    }
  }
  for (const folder of configFolders(root)) addDrizzleSchemas(folder);

  // A package.json above the scanned folder lists the package's public entry points, which build from this folder.
  function addAncestorManifest(folder) {
    const manifest = readConfig(folder, 'package.json');
    const entries = stringValues([manifest.main, manifest.module, manifest.browser, manifest.bin, manifest.exports]);
    for (const entry of entries) {
      const entryBelowRoot = entryBelowScanRoot(entry, folder, root);
      if (entryBelowRoot === undefined) continue;
      if (entry.includes('*')) addWildcardEntry('.', entryBelowRoot, known, explicit);
      else addEntry('.', entryBelowRoot);
    }
  }
  for (const folder of configFolders(root).slice(1)) {
    if (fs.existsSync(path.join(folder, 'package.json'))) addAncestorManifest(folder);
  }

  // Another member of the same monorepo may deep-import this package by name, which no scanned file shows.
  const siblingUsages = [];
  const ownManifest = readConfig(root, 'package.json');
  if (typeof ownManifest.name === 'string') {
    for (const [subpath, names] of siblingImports(ownManifest.name, siblingWorkspaces(root))) {
      for (const file of entryFiles('.', subpath)) siblingUsages.push({ to: file, names });
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

  // A file holding only comments, kept on purpose so that a build or tool finds the path it expects.
  const placeholders = new Map();
  function isPlaceholder(file) {
    if (fileFacts?.has(file)) return fileFacts.get(file).placeholder;
    if (!placeholders.has(file)) {
      const size = ts.sys.getFileSize?.(path.join(root, file)) ?? Infinity;
      const sourceFile = size <= placeholderMaxBytes ? parseScript(path.join(root, file)) : undefined;
      placeholders.set(file, Boolean(sourceFile) && sourceFile.statements.length === 0);
    }
    return placeholders.get(file);
  }

  function isEntryPoint(file) {
    if (
      explicit.has(file) ||
      isPlaceholder(file) ||
      isToolingFile(file) ||
      packageRootEntry.test(packageRelative(file))
    )
      return true;
    return /(?:^|\/)app\//.test(file) && packageDirectories.get(nearestPackage(file)) === true;
  }
  return {
    isEntryPoint,
    operatorScripts: operatorReferences(root, inventory, known),
    siblingUsages,
    isToolingFile,
    workspacePackages,
    isPrivateApplication: (file) => privateApplications.has(nearestPackage(file)),
  };
}

module.exports = { createEntryPoints };
