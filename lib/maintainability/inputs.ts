import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { ancestorAliasOptions } from './ancestor-aliases.js';
import { isBuildOutputFolder } from '../shared/build-output.js';
import type {
  CompilerOptions,
  Diagnostic,
  ExtendedConfigCacheEntry,
  ModuleResolutionCache,
  ResolutionMode,
  SourceFile,
  StringLiteralLike,
} from 'typescript';
import type { ModuleResolver } from './types/module-resolver.js';
import { coveringConfig, missingPackageBase } from '../shared/workspaces.js';

// The compiler settings that apply to one folder, with the caches that make resolving under them
// cheap.
interface ResolutionSettings {
  options: CompilerOptions;
  cache: ModuleResolutionCache;
  formats: Map<string, ResolutionMode>;
}

const ignoredFolders = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.next',
  '.nuxt',
  '.turbo',
  '.yarn',
  '.cache',
  '.worktrees',
  '.venv',
  '__pycache__',
  '.tox',
  '.pytest_cache',
]);
const implementation = /(?<!\.d)\.[cm]?[jt]sx?$/i;
const slash = (value: string): string => value.split(path.sep).join('/');
const notedBases = new Set<string | undefined>();

// Projects usually share their bases, so each missing base is noted once.
function noteMissingBase(diagnostic: Diagnostic): void {
  const base = missingPackageBase(diagnostic);
  if (notedBases.has(base)) return;
  notedBases.add(base);
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  let location = '';
  if (diagnostic.file && diagnostic.start !== undefined) {
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    location = diagnostic.file.fileName + '(' + (line + 1) + ',' + (character + 1) + ') ';
  }
  console.error(`Note: ${location}${message} Checked with this config's own settings until it is installed.`);
}

function listFiles(
  root: string,
  exclude: readonly string[] = [],
  isIgnored: (file: string) => boolean = () => false,
): string[] {
  const directory = path.resolve(root);
  const exclusions = new Set(
    exclude.map((value) => path.posix.normalize(value.replaceAll('\\', '/')).replace(/\/$/, '')),
  );
  const files = new Set<string>();
  const folders = new Map<string, boolean>([['.', true]]);

  function ignoredFolder(relative: string): boolean {
    const name = path.posix.basename(relative);
    return (
      isIgnored(relative) ||
      ignoredFolders.has(name) ||
      isBuildOutputFolder(directory, relative) ||
      (name === 'venv' && fs.existsSync(path.join(directory, relative, 'pyvenv.cfg')))
    );
  }

  // Git can still list an indexed child after its parent directory was replaced by a symlink.
  function safeFolder(relative: string): boolean {
    const known = folders.get(relative);
    if (known !== undefined) return known;
    const permitted =
      !ignoredFolder(relative) &&
      !exclusions.has(relative) &&
      safeFolder(path.posix.dirname(relative)) &&
      fs.lstatSync(path.join(directory, relative), { throwIfNoEntry: false })?.isDirectory() === true;
    folders.set(relative, permitted);
    return permitted;
  }
  function ignoredFile(relative: string): boolean {
    return exclusions.has(relative) || isIgnored(relative) || /(?:\.min\.(?:[cm]?js|css)|\.map)$/i.test(relative);
  }
  function addGitEntries(relative: string, output: string): void {
    for (const name of output.split('\0')) {
      if (!name) continue;
      const file = path.posix.join(relative, name);
      if (ignoredFile(file) || !safeFolder(path.posix.dirname(file))) continue;
      const absolute = path.join(directory, file);
      const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
      if (stat?.isFile()) files.add(file);
      else if (stat?.isDirectory() && safeFolder(file) && fs.existsSync(path.join(absolute, '.git'))) scan(file, true);
    }
  }
  function scan(relative: string, probeGit: boolean): void {
    const absolute = path.join(directory, relative);
    if (probeGit) {
      const result = spawnSync(
        'git',
        ['-C', absolute, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024 },
      );
      if (result.status === 0) return addGitEntries(relative, result.stdout);
      const spawnCode = result.error && 'code' in result.error ? result.error.code : undefined;
      if (spawnCode !== 'ENOENT' && !/not a git repository/i.test(result.stderr || '')) {
        throw result.error || new Error('Cannot inventory Git working tree ' + absolute + ': ' + result.stderr.trim());
      }
    }
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const file = path.posix.join(relative, entry.name);
      if (ignoredFile(file)) continue;
      if (entry.isFile()) files.add(file);
      else if (entry.isDirectory() && !ignoredFolder(file)) {
        scan(file, fs.existsSync(path.join(directory, file, '.git')));
      }
    }
  }
  if (!exclusions.has('.')) scan('.', true);
  return [...files].sort();
}

// `declarationFiles` are .d.ts files that are never import targets but still resolve their own
// imports.
function createResolver(
  root: string,
  fileSet: Iterable<string>,
  declarationFiles: readonly string[] = [],
): ModuleResolver {
  const directory = path.resolve(root);
  const canonical = ts.sys.useCaseSensitiveFileNames
    ? (value: string) => value
    : (value: string) => value.toLowerCase();
  const indexed = new Map<string, string>();
  for (const file of fileSet) {
    if (!implementation.test(file)) continue;
    const absolute = path.resolve(directory, file);
    const relative = path.relative(directory, absolute);
    if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
      indexed.set(canonical(absolute), slash(relative));
    }
  }
  const containers = new Set(declarationFiles.map((file) => canonical(path.resolve(directory, file))));
  const settingsByFolder = new Map<string, ResolutionSettings>();
  const extendedConfigs = new Map<string, ExtendedConfigCacheEntry>();
  // Many files probe the same candidate paths, such as one package.json per dependency lookup.
  function memoized<Result>(probe: (value: string) => Result): (value: string) => Result {
    const known = new Map<string, Result>();
    return (value) => {
      const cached = known.get(value);
      if (cached !== undefined) return cached;
      const result = probe(value);
      known.set(value, result);
      return result;
    };
  }
  const readJsonFile = memoized((file: string) => ts.sys.readFile(file));
  const host = {
    ...ts.sys,
    readFile: (file: string) => (path.basename(file) === 'package.json' ? readJsonFile(file) : undefined),
    directoryExists: memoized(ts.sys.directoryExists),
    fileExists: memoized(ts.sys.fileExists),
    realpath: ts.sys.realpath ? memoized(ts.sys.realpath) : undefined,
  };
  // Parsing compiler settings needs extends resolution; source discovery has already enumerated
  // inputs.
  const configHost = {
    ...host,
    readFile: (file: string) => (/\.json$/i.test(file) ? readJsonFile(file) : undefined),
    readDirectory: () => [],
  };
  function settings(folder: string): ResolutionSettings {
    const known = settingsByFolder.get(folder);
    if (known) return known;
    const isRoot = canonical(folder) === canonical(directory);
    // A scanned folder inside a package resolves its aliases with the ancestor config that covers
    // it.
    const config =
      ['tsconfig.json', 'jsconfig.json'].map((name) => path.join(folder, name)).find(host.fileExists) ??
      (isRoot ? coveringConfig(directory) : undefined);
    let context: ResolutionSettings;
    if (config || isRoot) {
      let options: CompilerOptions = {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowJs: true,
      };
      if (config) {
        const loaded = ts.readConfigFile(config, configHost.readFile);
        const parsed = loaded.error
          ? undefined
          : ts.parseJsonConfigFileContent(
              loaded.config,
              configHost,
              path.dirname(config),
              undefined,
              config,
              undefined,
              undefined,
              extendedConfigs,
            );
        // A base config from a package is missing until dependencies are installed; its workspace
        // imports would not resolve either, so scan with the local settings instead of failing.
        const configErrors = parsed ? parsed.errors : loaded.error ? [loaded.error] : [];
        const missingBases = configErrors.filter((item) => missingPackageBase(item) !== undefined);
        for (const item of missingBases) noteMissingBase(item);
        const error = configErrors.find(
          (item) => item.code !== 18002 && item.code !== 18003 && !missingBases.includes(item),
        );
        if (error)
          throw new Error(
            'Invalid compiler configuration ' + config + ': ' + ts.flattenDiagnosticMessageText(error.messageText, ' '),
          );
        options = parsed?.options ?? options;
      }
      if (isRoot && !options.paths) options = { ...options, ...ancestorAliasOptions(directory) };
      context = { options, cache: ts.createModuleResolutionCache(folder, canonical, options), formats: new Map() };
    } else {
      context = settings(path.dirname(folder));
    }
    settingsByFolder.set(folder, context);
    return context;
  }
  function resolve(
    specifier: string,
    containingFileAbsolute: string,
    usageNode?: StringLiteralLike,
    outsideProject?: () => void,
  ): string | undefined {
    const filename = path.resolve(containingFileAbsolute);
    if (!indexed.has(canonical(filename)) && !containers.has(canonical(filename))) return;
    const { options, cache, formats } = settings(path.dirname(filename));
    if (!formats.has(filename)) {
      formats.set(filename, ts.getImpliedNodeFormatForFile(filename, cache.getPackageJsonInfoCache(), host, options));
    }
    let mode = formats.get(filename);
    if (usageNode) {
      let source: SourceFile & { impliedNodeFormat?: ResolutionMode } = usageNode.getSourceFile();
      if (source.impliedNodeFormat !== mode) {
        source = Object.create(source);
        source.impliedNodeFormat = mode;
      }
      mode = ts.getModeForUsageLocation(source, usageNode, options);
    }
    const resolved = ts.resolveModuleName(specifier, filename, options, host, cache, undefined, mode).resolvedModule;
    if (resolved) {
      const local = indexed.get(canonical(path.resolve(resolved.resolvedFileName)));
      if (!local && /(?:^|[\\/])node_modules[\\/]/.test(resolved.resolvedFileName)) outsideProject?.();
      return local;
    }
  }
  resolve.optionsFor = (filename: string) => {
    const absolute = path.resolve(filename);
    if (indexed.has(canonical(absolute))) return settings(path.dirname(absolute)).options;
  };
  return resolve;
}

export { listFiles, createResolver };
