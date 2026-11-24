import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { localDockerBuild, dockerNodeEntry } from './docker-entry-points.cjs';
import { noteUnreadable } from '../shared/coverage-notes.cjs';
import { configFile, jsonConfigFile, configFilePaths, jsonConfigFilePaths } from './config-entry-points.cjs';
import { mochaConfigYaml, mochaScriptPaths, mochaYamlPaths } from './mocha-entry-points.cjs';
import { htmlScriptEntries, maxHtmlEntryBytes } from './html-entry-points.cjs';
import { operatorReferences } from './operator-references.cjs';
import { runtimeDirectories, isInside } from './runtime-directories.cjs';
import { testSourcePattern } from './snapshot-context.cjs';
import { walkNodes } from './walk.cjs';
import { workflowNodeEntries } from './workflow-entry-points.cjs';
import { maxConsumerBytes, placeholderMaxBytes } from './source-facts.cjs';
import { collectModuleUsage } from './module-usage.cjs';
import type { Expression, Node, SourceFile } from 'typescript';
import type { EntryPoints } from './types/entry-points.cjs';
import type { ImportedNames, ModuleImport } from './types/module-usage.cjs';
import type { SourceFacts } from './types/source-facts.cjs';

// The parts of a package.json the entry-point search reads.
interface PackageManifest {
  name?: unknown;
  private?: unknown;
  main?: unknown;
  module?: unknown;
  browser?: unknown;
  bin?: unknown;
  exports?: unknown;
  workspaces?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  [key: string]: unknown;
}

// nest-cli.json: the root project and each named project say where their entry file is.
interface NestProject {
  sourceRoot?: string;
  root?: string;
  entryFile?: string;
  projects?: Record<string, NestProject>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const builtExtensions: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
  '.jsx': ['.tsx'],
};
const outputFolders = new Set(['dist', 'build', 'lib', 'out']);
const commandSeparators = /[\s'"=]+/;
const routeFrameworks = /^(?:next|nuxt|@remix-run\/.+|react-router|@react-router\/.+|@sveltejs\/kit|astro|gatsby)$/;

// Files that tools, frameworks or people run directly, or that are discovered by folder or file
// name instead of an import.
const conventionalFolder =
  /(?:^|\/)(?:__tests__|__mocks__|tests?|e2e|cypress|playwright|\.storybook|scripts?|bin|[\w-]*migrations?[\w-]*|seeds?|seeders?|prisma|pages|routes|examples?|docs|benchmarks?|fixtures|public|static)\//i;
const conventionalName =
  /(?:[.-](?:config|entity|migration|subscriber|seed|seeder|stories|story|global-?setup)\.[cm]?[jt]sx?$|(?:^|\/)\.?[\w-]*rc\.[cm]?[jt]s$|(?:^|\/)\d{10,}[\w-]*\.[jt]s$|(?:^|\/)(?:gulpfile|gruntfile|main|middleware|instrumentation|global-?setup)\.[cm]?[jt]sx?$|(?:^|\/)(?:jest|vitest)\.(?:setup|global-?setup)|(?:^|\/)app\/(?:entry\.client|entry\.server|root|routes)\.[cm]?[jt]sx?$)/i;
const packageRootEntry = /^(?:src\/)?(?:index|server|app|worker|cli|handler)\.[cm]?[jt]sx?$/;
const githubWorkflow = /^\.github\/workflows\/[^/]+\.ya?ml$/;

function readConfig<Shape extends object>(root: string, file: string): Partial<Shape> {
  const absolute = path.join(root, file);
  const text = ts.sys.readFile(absolute);
  if (text === undefined) return {};
  return ts.parseConfigFileTextToJson(absolute, text).config ?? {};
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringValues);
  return [];
}

// Words of shell commands that look like a file or a path, such as `node dist/main.js` or
// `--entryFile queue/worker`.
function commandPaths(commands: readonly string[]): string[] {
  return commands
    .flatMap((command) => command.split(commandSeparators))
    .filter((word) => /\.[cm]?[jt]sx?$/.test(word) || word.includes('/'));
}

function packageEntryPaths(manifest: PackageManifest): string[] {
  const scriptTokens = commandPaths(stringValues(manifest.scripts));
  return [
    ...stringValues([manifest.main, manifest.module, manifest.browser, manifest.bin, manifest.exports]),
    ...scriptTokens,
  ];
}

function nestEntryPaths(config: NestProject): string[] {
  const projects = Object.values(config.projects ?? {});
  return [config, ...projects].map(
    (project) => `${project.sourceRoot ?? (project === config ? 'src' : project.root)}/${project.entryFile ?? 'main'}`,
  );
}

// Node substitutes the same captured subpath for every star on the right side of an exports map.
function exportTargetMatcher(pattern: string): (stem: string) => boolean {
  const parts = pattern.split('*');
  const stars = parts.length - 1;
  const literalLength = pattern.length - stars;
  return (stem) => {
    const lastPart = parts[parts.length - 1];
    const width = (stem.length - literalLength) / stars;
    if (width < 0 || !Number.isInteger(width) || !stem.startsWith(parts[0]) || !stem.endsWith(lastPart)) return false;
    if (stars === 1) return true;
    const capture = stem.slice(parts[0].length, parts[0].length + width);
    return parts.join(capture) === stem;
  };
}

function addWildcardEntry(directory: string, entry: string, known: ReadonlySet<string>, explicit: Set<string>): void {
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

function parseScript(absolute: string): SourceFile | undefined {
  const text = ts.sys.readFile(absolute);
  return text === undefined ? undefined : ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true);
}

function literalStrings(expression: Expression): string[] {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (!ts.isArrayLiteralExpression(expression)) return [];
  const strings: string[] = [];
  for (const element of expression.elements) {
    if (!ts.isStringLiteralLike(element)) return [];
    strings.push(element.text);
  }
  return strings;
}

// `schema: './db/*.table.ts'` (a string, array or glob) in a drizzle config names files drizzle-kit
// loads.
function drizzleSchemaPaths(sourceFile: SourceFile): string[] {
  const paths: string[] = [];
  walkNodes(sourceFile, (node: Node) => {
    if (!ts.isPropertyAssignment(node) || !ts.isIdentifier(node.name) || node.name.text !== 'schema') return;
    paths.push(...literalStrings(ts.skipOuterExpressions(node.initializer)));
  });
  return paths;
}

const workingDirectoryCalls = /^(?:process\.cwd\(\)|__dirname)$/;

// `.sequelizerc` names the config, models, seeders and migrations with
// path.resolve('src/db/config.cjs'), relative to the folder sequelize-cli runs in.
function sequelizePaths(sourceFile: SourceFile): string[] {
  const paths: string[] = [];
  walkNodes(sourceFile, (node: Node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    if (!['resolve', 'join'].includes(node.expression.name.text)) return;
    const parts = node.arguments.filter((argument) => !workingDirectoryCalls.test(argument.getText(sourceFile)));
    if (parts.length && parts.every(ts.isStringLiteralLike))
      paths.push(path.posix.join(...parts.map((part) => part.text)));
  });
  return paths;
}

function globPattern(rawGlob: string): RegExp {
  const glob = rawGlob.replaceAll(/(?:\*\*\/)+/g, '**/').replaceAll(/\*{3,}/g, '**');
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
    else pattern += character.replaceAll(/[.+^$()|[\]\\]/g, '\\$&');
  }
  try {
    return new RegExp('^' + pattern + '$');
  } catch {
    return /$^/;
  }
}

// Folders from the scan root up to the first one holding package.json or .git, where tool configs
// usually live.
function configFolders(root: string): string[] {
  const folders: string[] = [];
  for (let folder = path.resolve(root); ; folder = path.dirname(folder)) {
    folders.push(folder);
    const boundary = fs.existsSync(path.join(folder, 'package.json')) || fs.existsSync(path.join(folder, '.git'));
    if (boundary || path.dirname(folder) === folder) return folders;
  }
}

const sourceFilePattern = /\.[cm]?[jt]sx?$/;
const skippedFolders = new Set(['node_modules', 'dist', 'build', 'out', 'coverage']);

function readFolder(folder: string): fs.Dirent[] {
  try {
    return fs.readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    // A missing folder is expected; one that exists but cannot be listed hides files that may use
    // an export.
    if (!(error instanceof Error)) throw error;
    noteUnreadable({ error, location: folder, consequence: 'skipped it when looking for entry points' });
    return [];
  }
}

function sourceFilesBelow(folder: string): string[] {
  const files: string[] = [];
  const pending = [folder];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
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

function workspaceGlobs(folder: string): string[] | undefined {
  const { workspaces } = readConfig<PackageManifest>(folder, 'package.json');
  const declared = Array.isArray(workspaces) ? workspaces : isRecord(workspaces) ? workspaces.packages : undefined;
  if (Array.isArray(declared)) return declared.filter((glob): glob is string => typeof glob === 'string');
  const pnpm = ts.sys.readFile(path.join(folder, 'pnpm-workspace.yaml'));
  // Only the indented lines under `packages:` list members; other keys hold lists too.
  const packagesBlock = pnpm?.match(/^packages:[^\S\n]*\r?\n((?:[ \t]+.*(?:\r?\n|$)|[ \t]*\r?\n)*)/m);
  if (!packagesBlock) return;
  return [...packagesBlock[1].matchAll(/^\s*-\s*['"]?([^'"#\s]+)['"]?/gm)].map((match) => match[1]);
}

// Member globs are shallow (apps/*, packages/**), so a bounded walk of folders is enough.
function matchingMemberFolders(folder: string, included: readonly RegExp[]): string[] {
  const members: string[] = [];
  const pending = [''];
  for (let relative = pending.pop(); relative !== undefined; relative = pending.pop()) {
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
function siblingWorkspaces(packageFolder: string): string[] {
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
function collectRuntimeFolders(
  known: ReadonlySet<string>,
  root: string,
  fileFacts: ReadonlyMap<string, SourceFacts> | undefined,
): Set<string> {
  const runtimeFolders = new Set<string>();
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

// Deep imports such as `@acme/lib/client/download` from sibling workspace members, as subpaths of
// the package with the names they import. A subpath imported several times keeps every name, and
// `all` once any import uses the module.
function siblingImports(packageName: string, members: readonly string[]): Map<string, ImportedNames> {
  const prefix = packageName + '/';
  const imports = new Map<string, ImportedNames>();
  for (const member of members) {
    for (const file of sourceFilesBelow(member)) recordFileSiblingImports(imports, file, prefix);
  }
  return imports;
}

function recordFileSiblingImports(imports: Map<string, ImportedNames>, file: string, prefix: string): void {
  if ((ts.sys.getFileSize?.(file) ?? 0) > maxConsumerBytes) return;
  const text = ts.sys.readFile(file);
  if (!text?.includes(prefix)) return;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  for (const { specifier, names } of collectModuleUsage(source, file, () => undefined).unresolved) {
    if (specifier.startsWith(prefix)) recordSiblingImport(imports, specifier.slice(prefix.length), names);
  }
}

function recordSiblingImport(imports: Map<string, ImportedNames>, subpath: string, names: ImportedNames): void {
  const known = imports.get(subpath);
  if (known === 'all' || names === 'all') imports.set(subpath, 'all');
  else imports.set(subpath, [...new Set([...(known ?? []), ...names])]);
}

// An entry that an ancestor package.json declares relative to its own folder, such as
// `./dist/api/*.js`, as the path it takes from the scanned folder. The scanned `src` is what builds
// into that output folder.
function entryBelowScanRoot(entry: string, ancestorFolder: string, root: string): string | undefined {
  const relative = path.posix.normalize(entry.replaceAll('\\', '/'));
  const scannedPrefix = path.relative(ancestorFolder, root).replaceAll('\\', '/') + '/';
  if (relative.startsWith(scannedPrefix)) return relative.slice(scannedPrefix.length);
  const [first, ...rest] = relative.split('/');
  if (outputFolders.has(first)) return rest.join('/');
}

// A private package that declares none of these is an application rather than a library.
const packageEntryKeys = ['main', 'module', 'browser', 'bin', 'exports', 'types', 'typings', 'typesVersions'];

// `inventory` is every project-relative file; `sourceFiles` the analysed ones. Configuration files
// are read from disk.
// `fileFacts` holds what the scan already learned from each analysed file, so those files are not
// read again.
function createEntryPoints(
  root: string,
  inventory: readonly string[],
  sourceFiles: readonly string[],
  fileFacts?: ReadonlyMap<string, SourceFacts>,
): EntryPoints {
  const known = new Set(sourceFiles);
  const explicit = new Set<string>();
  const packageDirectories = new Map<string, boolean>();
  const privateApplications = new Set<string>();
  const workspacePackages = new Map<string, string>();

  // The analysed files that a package entry such as `dist/main.js` or `queue/worker` can name.
  function entryFiles(directory: string, entry: string): string[] {
    if (entry.includes('*')) return [];
    const relative = path.posix.normalize(entry.replaceAll('\\', '/'));
    const extension = path.posix.extname(relative);
    const stem = sourceExtensions.includes(extension) ? relative.slice(0, -extension.length) : relative;
    const [firstSegment, ...rest] = stem.split('/');
    // Build output such as dist/main.js comes from src/main.ts, and tools accept paths relative to
    // src.
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

  function addEntry(directory: string, entry: string): void {
    for (const file of entryFiles(directory, entry)) explicit.add(file);
  }

  const inventoryFiles = new Set(inventory);
  function addDockerScriptEntries(directory: string, scripts: readonly unknown[]): void {
    for (const script of scripts) {
      if (typeof script !== 'string') continue;
      const build = localDockerBuild(script, directory);
      if (!build || !inventoryFiles.has(build.dockerfile)) continue;
      const entry = dockerNodeEntry(ts.sys.readFile(path.join(root, build.dockerfile)), build.contextDirectory, known);
      if (entry) explicit.add(entry);
    }
  }

  function addManifest(directory: string, file: string): void {
    const manifest = readConfig<PackageManifest>(root, file);
    if (manifest.private === true && !packageEntryKeys.some((key) => key in manifest))
      privateApplications.add(directory);
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies };
    if (typeof manifest.name === 'string' && directory !== '.') workspacePackages.set(manifest.name, directory);
    packageDirectories.set(
      directory,
      Object.keys(dependencies).some((dependency) => routeFrameworks.test(dependency)),
    );
    for (const entry of packageEntryPaths(manifest)) addEntry(directory, entry);
    addDockerScriptEntries(directory, Object.values(manifest.scripts ?? {}));
    // Mocha and Jest also read their options from package.json instead of a config file.
    for (const script of Object.values(manifest.scripts ?? {}))
      if (typeof script === 'string')
        for (const entry of mochaScriptPaths(script)) addConfigPath(directory, entry, true);
    for (const toolKey of ['mocha', 'jest'])
      for (const entry of jsonConfigFilePaths(isRecord(manifest[toolKey]) ? manifest[toolKey] : {}))
        addConfigPath(directory, entry, toolKey === 'mocha');
    for (const entry of stringValues(manifest.exports))
      if (entry.includes('*')) addWildcardEntry(directory, entry, known, explicit);
  }

  function addKnownEntry(file: string): void {
    if (known.has(file)) explicit.add(file);
  }

  function addHtmlScripts(file: string, directory: string): void {
    const absolute = path.join(root, file);
    const size = ts.sys.getFileSize?.(absolute);
    if (!size || size > maxHtmlEntryBytes) return;
    for (const src of htmlScriptEntries(ts.sys.readFile(absolute))) {
      addKnownEntry(path.posix.join(directory, src));
    }
  }

  // Mocha loads every file in a folder named as a spec; other tools resolve a folder to its index,
  // so only mocha paths expand.
  function addFolderFiles(directory: string, entry: string): void {
    const folder = path.posix.normalize(path.posix.join(directory, entry.replaceAll('\\', '/'))).replace(/\/$/, '');
    if (folder === '.' || folder.startsWith('..')) return;
    for (const file of known) if (file.startsWith(folder + '/')) explicit.add(file);
  }

  function addConfigPath(directory: string, entry: string, loadsFolder = false): void {
    if (!/[*?{]/.test(entry)) {
      addEntry(directory, entry);
      if (loadsFolder && !sourceExtensions.includes(path.posix.extname(entry))) addFolderFiles(directory, entry);
      return;
    }
    const pattern = globPattern(path.posix.normalize(path.posix.join(directory, entry)));
    for (const file of known) if (pattern.test(file)) explicit.add(file);
  }

  function addConfigFiles(file: string, directory: string): void {
    const paths = jsonConfigFile.test(file)
      ? jsonConfigFilePaths(readConfig<Record<string, unknown>>(root, file))
      : configFilePaths(parseScript(path.join(root, file)) ?? ts.createSourceFile(file, '', ts.ScriptTarget.Latest));
    for (const entry of paths) addConfigPath(directory, entry, /\.mocharc\./.test(file));
  }

  function addEntries(directory: string, entries: readonly string[]): void {
    for (const entry of entries) addEntry(directory, entry);
  }

  function addSequelizeEntries(file: string, directory: string): void {
    const sourceFile = parseScript(path.join(root, file));
    addEntries(directory, sourceFile ? sequelizePaths(sourceFile) : []);
  }

  // Each file kind names its entry points in its own way; the first kind that matches wins.
  function addFileEntries(file: string): void {
    const directory = path.posix.dirname(file);
    const name = path.posix.basename(file);
    if (name === 'package.json') return addManifest(directory, file);
    if (name === 'project.json')
      return addEntries(directory, commandPaths(stringValues(readConfig<Record<string, unknown>>(root, file))));
    if (name === 'nest-cli.json') return addEntries(directory, nestEntryPaths(readConfig<NestProject>(root, file)));
    if (/^tsconfig(?:\..+)?\.json$/.test(name))
      return addEntries(directory, readConfig<{ files?: string[] }>(root, file).files ?? []);
    if (githubWorkflow.test(file)) {
      for (const entry of workflowNodeEntries(ts.sys.readFile(path.join(root, file)) ?? '')) addKnownEntry(entry);
      return;
    }
    if (configFile.test(file) || jsonConfigFile.test(file)) return addConfigFiles(file, directory);
    if (/\.html$/i.test(name)) return addHtmlScripts(file, directory);
    if (mochaConfigYaml.test(name)) {
      for (const entry of mochaYamlPaths(ts.sys.readFile(path.join(root, file)) ?? ''))
        addConfigPath(directory, entry, true);
      return;
    }
    if (name === '.sequelizerc') addSequelizeEntries(file, directory);
  }
  for (const file of inventory) addFileEntries(file);

  // Folders that source code reads from by a computed file name or serves statically hold files
  // nothing imports.
  const runtimeFolders = collectRuntimeFolders(known, root, fileFacts);
  for (const file of known) if ([...runtimeFolders].some((folder) => isInside(file, folder))) explicit.add(file);

  // Drizzle configs often sit above the scanned folder, at the package or repository root.
  function addPathOrGlob(configFolder: string, entry: string): void {
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
  function addDrizzleSchemas(folder: string) {
    for (const extension of ['.ts', '.js', '.mjs', '.cjs', '.mts', '.cts']) {
      const sourceFile = parseScript(path.join(folder, 'drizzle.config' + extension));
      for (const entry of sourceFile ? drizzleSchemaPaths(sourceFile) : []) addPathOrGlob(folder, entry);
    }
  }
  for (const folder of configFolders(root)) addDrizzleSchemas(folder);

  // A package.json above the scanned folder lists the package's public entry points, which build
  // from this folder.
  function addAncestorManifest(folder: string): void {
    const manifest = readConfig<PackageManifest>(folder, 'package.json');
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

  // Another member of the same monorepo may deep-import this package by name, which no scanned file
  // shows.
  const siblingUsages: ModuleImport[] = [];
  const ownManifest = readConfig<PackageManifest>(root, 'package.json');
  if (typeof ownManifest.name === 'string') {
    for (const [subpath, names] of siblingImports(ownManifest.name, siblingWorkspaces(root))) {
      for (const file of entryFiles('.', subpath)) siblingUsages.push({ to: file, names });
    }
  }

  function nearestPackage(file: string): string {
    for (let directory = path.posix.dirname(file); ; directory = path.posix.dirname(directory)) {
      if (packageDirectories.has(directory)) return directory;
      if (directory === '.') return '.';
    }
  }

  function packageRelative(file: string): string {
    const packageDirectory = nearestPackage(file);
    return packageDirectory === '.' ? file : file.slice(packageDirectory.length + 1);
  }

  // Tests, scripts, configuration and migrations are run by tools, so what they load says nothing
  // about the application.
  function isToolingFile(file: string): boolean {
    // Files beside package.json are scripts run by hand, a Dockerfile or CI.
    return (
      testSourcePattern.test(file) ||
      conventionalFolder.test(file) ||
      conventionalName.test(file) ||
      !packageRelative(file).includes('/')
    );
  }

  // A file holding only comments, kept on purpose so that a build or tool finds the path it
  // expects.
  const placeholders = new Map<string, boolean>();
  function isPlaceholder(file: string): boolean {
    const facts = fileFacts?.get(file);
    if (facts) return facts.placeholder;
    const cached = placeholders.get(file);
    if (cached !== undefined) return cached;
    const size = ts.sys.getFileSize?.(path.join(root, file)) ?? Infinity;
    const sourceFile = size <= placeholderMaxBytes ? parseScript(path.join(root, file)) : undefined;
    const placeholder = sourceFile !== undefined && sourceFile.statements.length === 0;
    placeholders.set(file, placeholder);
    return placeholder;
  }

  function isEntryPoint(file: string): boolean {
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
    isPrivateApplication: (file: string) => privateApplications.has(nearestPackage(file)),
  };
}

export { createEntryPoints };
