'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ignoredFolders = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'coverage',
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
  'target',
  'vendor',
]);
const implementation = /(?<!\.d)\.[cm]?[jt]sx?$/i;
// TypeScript's "File '{0}' not found." diagnostic.
const missingFileCode = 6053;
const slash = (value) => value.split(path.sep).join('/');

function listFiles(root, exclude = [], isIgnored = () => false) {
  const directory = path.resolve(root);
  const exclusions = new Set(
    exclude.map((value) => path.posix.normalize(value.replaceAll('\\', '/')).replace(/\/$/, '')),
  );
  const files = new Set();
  const folders = new Map([['.', true]]);

  function ignoredFolder(relative) {
    const name = path.posix.basename(relative);
    return (
      isIgnored(relative) ||
      ignoredFolders.has(name) ||
      (name === 'venv' && fs.existsSync(path.join(directory, relative, 'pyvenv.cfg')))
    );
  }

  // Git can still list an indexed child after its parent directory was replaced by a symlink.
  function safeFolder(relative) {
    if (folders.has(relative)) return folders.get(relative);
    const permitted =
      !ignoredFolder(relative) &&
      !exclusions.has(relative) &&
      safeFolder(path.posix.dirname(relative)) &&
      fs.lstatSync(path.join(directory, relative), { throwIfNoEntry: false })?.isDirectory() === true;
    folders.set(relative, permitted);
    return permitted;
  }
  function ignoredFile(relative) {
    return exclusions.has(relative) || isIgnored(relative) || /(?:\.min\.(?:[cm]?js|css)|\.map)$/i.test(relative);
  }
  function addGitEntries(relative, output) {
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
  function scan(relative, probeGit) {
    const absolute = path.join(directory, relative);
    if (probeGit) {
      const result = spawnSync(
        'git',
        ['-C', absolute, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024 },
      );
      if (result.status === 0) return addGitEntries(relative, result.stdout);
      if (result.error?.code !== 'ENOENT' && !/not a git repository/i.test(result.stderr || '')) {
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

function createResolver(root, fileSet) {
  const directory = path.resolve(root);
  const canonical = ts.sys.useCaseSensitiveFileNames ? (value) => value : (value) => value.toLowerCase();
  const indexed = new Map();
  for (const file of fileSet) {
    if (!implementation.test(file)) continue;
    const absolute = path.resolve(directory, file);
    const relative = path.relative(directory, absolute);
    if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
      indexed.set(canonical(absolute), slash(relative));
    }
  }
  const settingsByFolder = new Map();
  const extendedConfigs = new Map();
  // Many files probe the same candidate paths, such as one package.json per dependency lookup.
  function memoized(probe) {
    const known = new Map();
    return (value) => {
      let result = known.get(value);
      if (result === undefined) {
        result = probe(value);
        known.set(value, result);
      }
      return result;
    };
  }
  const host = {
    ...ts.sys,
    readFile: (file) => (path.basename(file) === 'package.json' ? ts.sys.readFile(file) : undefined),
    directoryExists: memoized(ts.sys.directoryExists),
    fileExists: memoized(ts.sys.fileExists),
    realpath: memoized(ts.sys.realpath),
  };
  // Parsing compiler settings needs extends resolution; source discovery has already enumerated inputs.
  const configHost = {
    ...host,
    readFile: (file) => (/\.json$/i.test(file) ? ts.sys.readFile(file) : undefined),
    readDirectory: () => [],
  };
  function settings(folder) {
    if (settingsByFolder.has(folder)) return settingsByFolder.get(folder);
    const config = ['tsconfig.json', 'jsconfig.json'].map((name) => path.join(folder, name)).find(ts.sys.fileExists);
    let context;
    if (config || canonical(folder) === canonical(directory)) {
      let options = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true };
      if (config) {
        const loaded = ts.readConfigFile(config, configHost.readFile);
        const parsed = loaded.error
          ? { errors: [loaded.error] }
          : ts.parseJsonConfigFileContent(
              loaded.config,
              configHost,
              folder,
              undefined,
              config,
              undefined,
              undefined,
              extendedConfigs,
            );
        const packageBases = [loaded.config?.extends]
          .flat()
          .filter((base) => typeof base === 'string' && !/^(?:\.|\/|[a-z]:)/i.test(base));
        // A base config from a package is missing until dependencies are installed; its workspace imports
        // would not resolve either, so scan with the local settings instead of failing.
        const uninstalledBase = (item) =>
          item.code === missingFileCode &&
          packageBases.some((base) => ts.flattenDiagnosticMessageText(item.messageText, ' ').includes(base));
        const error = parsed.errors.find(
          (item) => item.code !== 18002 && item.code !== 18003 && !uninstalledBase(item),
        );
        if (error)
          throw new Error(
            'Invalid compiler configuration ' + config + ': ' + ts.flattenDiagnosticMessageText(error.messageText, ' '),
          );
        options = parsed.options;
      }
      context = { options, cache: ts.createModuleResolutionCache(folder, canonical, options), formats: new Map() };
    } else {
      context = settings(path.dirname(folder));
    }
    settingsByFolder.set(folder, context);
    return context;
  }
  function resolve(specifier, containingFileAbsolute, usageNode) {
    const filename = path.resolve(containingFileAbsolute);
    if (!indexed.has(canonical(filename))) return;
    const { options, cache, formats } = settings(path.dirname(filename));
    if (!formats.has(filename)) {
      formats.set(filename, ts.getImpliedNodeFormatForFile(filename, cache.getPackageJsonInfoCache(), host, options));
    }
    let mode = formats.get(filename);
    if (usageNode) {
      let source = usageNode.getSourceFile();
      if (source.impliedNodeFormat !== mode) {
        source = Object.create(source);
        source.impliedNodeFormat = mode;
      }
      mode = ts.getModeForUsageLocation(source, usageNode, options);
    }
    const resolved = ts.resolveModuleName(specifier, filename, options, host, cache, undefined, mode).resolvedModule;
    if (resolved) return indexed.get(canonical(path.resolve(resolved.resolvedFileName)));
  }
  resolve.optionsFor = (filename) => {
    const absolute = path.resolve(filename);
    if (indexed.has(canonical(absolute))) return settings(path.dirname(absolute)).options;
  };
  return resolve;
}

module.exports = { listFiles, createResolver };
