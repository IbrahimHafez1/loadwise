'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { analyzeFile } = require('./analyze.cjs');
const { enableSchemaTooling } = require('./schema-tooling.cjs');
const {
  collectUninstalledDependencies,
  collectUnresolvedPackages,
  formatMissingPackagesNote,
  formatUninstalledDependencyNote,
} = require('./missing-packages.cjs');
const {
  compareFindings,
  isInScope,
  isSourceInput,
  mergeFinding,
  scanEntries,
  relativeToWorkingDirectory,
  resolveConfig,
} = require('./source-inputs.cjs');
const { recordSkippedFile } = require('./scan-outcome.cjs');
const { workspacePackagesAround, workspaceSourceEntry } = require('../shared/workspaces.cjs');
const compilerLibDirectory = path.dirname(require.resolve('typescript'));
const docMode = ts.JSDocParsingMode.ParseForTypeErrors;
const canonicalFileName = ts.createCompilerHost({}).getCanonicalFileName;

// Limit filesystem probe reuse to a single one-shot run. Watch uses TypeScript's live host.
function cachePathTest(test) {
  const results = new Map();
  return (filename) => {
    let exists = results.get(filename);
    if (exists === undefined) {
      exists = test(filename);
      results.set(filename, exists);
    }
    return exists;
  };
}

// Up to this many characters of file text stay cached, so a very large monorepo cannot exhaust the heap through it.
const maximumCachedCharacters = 64 * 1024 * 1024;

// Every config of a monorepo loads the shared packages again, so a one-shot run reads each file once. Files beyond
// the budget are read again on demand, which only costs time.
function cacheFileText(read) {
  const texts = new Map();
  let cachedCharacters = 0;
  return (filename) => {
    if (texts.has(filename)) return texts.get(filename);
    const text = read(filename);
    if (text !== undefined && cachedCharacters + text.length > maximumCachedCharacters) return text;
    texts.set(filename, text);
    cachedCharacters += text?.length ?? 0;
    return text;
  };
}

// A workspace entry is looked up for every unresolved import of the package, and each lookup probes many candidate files.
function cacheWorkspaceEntries() {
  const entries = new Map();
  return (directory, subpath) => {
    const key = JSON.stringify([directory, subpath]);
    if (!entries.has(key)) entries.set(key, workspaceSourceEntry(directory, subpath));
    return entries.get(key);
  };
}

function packageNameOf(specifier) {
  const [first, second] = specifier.split('/');
  return first.startsWith('@') ? `${first}/${second}` : first;
}

// Imports of a sibling workspace package whose built entry is missing (or that is not linked into node_modules) fall
// back to its source, so rules still see the types it exports. Packages outside the repository are never guessed.
function resolveWorkspaceSources(host, settings, workspacePackages, findWorkspaceEntry) {
  const cache = ts.createModuleResolutionCache(host.getCurrentDirectory(), host.getCanonicalFileName, settings);
  host.resolveModuleNameLiterals = (literals, containingFile, redirectedReference, options, containingSource) =>
    literals.map((literal) => {
      const mode = ts.getModeForUsageLocation(containingSource, literal, options);
      const resolution = ts.resolveModuleName(
        literal.text,
        containingFile,
        options,
        host,
        cache,
        redirectedReference,
        mode,
      );
      if (resolution.resolvedModule || /^[./]/.test(literal.text) || path.isAbsolute(literal.text)) return resolution;
      const name = packageNameOf(literal.text);
      const directory = workspacePackages.get(name);
      const resolvedFileName = directory && findWorkspaceEntry(directory, literal.text.slice(name.length + 1));
      if (!resolvedFileName) return resolution;
      return {
        resolvedModule: {
          resolvedFileName,
          extension: ts.extensionFromPath(resolvedFileName),
          isExternalLibraryImport: false,
        },
      };
    });
}

function createHost(settings, sharedLibs, probes, workspacePackages, findWorkspaceEntry) {
  const host = ts.createCompilerHost(settings);
  Object.assign(host, probes);
  host.jsDocParsingMode = docMode;
  if (workspacePackages?.size) resolveWorkspaceSources(host, settings, workspacePackages, findWorkspaceEntry);
  if (!sharedLibs) return host;
  const loadSource = host.getSourceFile;
  host.getSourceFile = (filename, languageOptions, onError, forceNew) => {
    if (
      !forceNew &&
      /^lib(?:\.[\w.-]+)?\.d\.ts$/.test(path.basename(filename)) &&
      path.dirname(path.resolve(filename)) === compilerLibDirectory
    ) {
      let snapshot = sharedLibs.snapshots.get(filename);
      if (!snapshot) {
        const contents = host.readFile(filename);
        if (contents !== undefined) {
          snapshot = ts.ScriptSnapshot.fromString(contents);
          sharedLibs.snapshots.set(filename, snapshot);
        }
      }
      if (snapshot) {
        // The registry separates ASTs by compiler settings and module format. Only this
        // installation's bundled declarations are immutable for the duration of a scan.
        return sharedLibs.registry.acquireDocument(
          filename,
          settings,
          snapshot,
          ts.version,
          ts.ScriptKind.TS,
          languageOptions,
        );
      }
    }
    return loadSource(filename, languageOptions, onError, forceNew);
  };
  return host;
}

function diagnosticText(diagnostic) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (!diagnostic.file || diagnostic.start === undefined) return message;
  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return diagnostic.file.fileName + '(' + (line + 1) + ',' + (character + 1) + ') ' + message;
}

// Projects written for TypeScript 5 keep options the bundled compiler deprecates; analysis is unaffected.
const analysisOptions = { noEmit: true, ignoreDeprecations: '6.0' };

// A `types` entry that is not installed leaves only those globals unresolved; any other option error is fatal.
const missingTypeLibraryCode = 2688;

function reportMissingTypeLibraries(diagnostics) {
  const names = diagnostics.map((diagnostic) => /'([^']+)'/.exec(diagnosticText(diagnostic))?.[1]);
  console.error(
    `Note: type libraries not installed (${names.filter(Boolean).join(', ')}); analysis continued without them.`,
  );
}

// TypeScript's "File '{0}' not found." diagnostic.
const missingFileCode = 6053;

// A base config from a package (`"extends": "@org/tsconfig/base.json"`) is missing until dependencies are installed,
// also when the config inherits it through a relative base. A missing relative base or input file is reported by
// path and stays fatal.
function missingPackageBase(diagnostic) {
  if (diagnostic.code !== missingFileCode) return undefined;
  const missing = /'([^']+)'/.exec(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))?.[1];
  return missing !== undefined && !/^(?:\.|\/|[a-z]:)/i.test(missing) ? missing : undefined;
}

function uninstalledBaseConfigs(parsed) {
  return parsed.errors.filter((diagnostic) => missingPackageBase(diagnostic) !== undefined);
}

// Each analyzer is { pillar, analyzeFile(program, sourceFile, policy, forEachSourceCandidate) }. With more than
// one, every finding is stamped with its analyzer's pillar so the caller can split the report.
const performanceAnalyzers = [{ pillar: 'performance', analyzeFile }];

function analyzeProgram(
  program,
  inputs = program.getRootFileNames(),
  scanned = new Set(),
  policy,
  forEachSourceCandidate,
  unresolvedPackages = new Set(),
  analyzers = performanceAnalyzers,
  skippedFiles,
) {
  const optionErrors = program.getOptionsDiagnostics();
  const missingLibraries = optionErrors.filter((diagnostic) => diagnostic.code === missingTypeLibraryCode);
  const fatalErrors = optionErrors.filter((diagnostic) => diagnostic.code !== missingTypeLibraryCode);
  if (fatalErrors.length) throw new Error(fatalErrors.map(diagnosticText).join('\n'));
  if (missingLibraries.length) reportMissingTypeLibraries(missingLibraries);
  const findings = [];
  const localFiles = new Set();
  const directory = program.getCurrentDirectory();
  for (const filename of inputs.filter(isSourceInput)) {
    const source = program.getSourceFile(filename);
    if (!source) throw new Error('Unable to load source: ' + filename);
    if (localFiles.has(source)) continue;
    const syntaxErrors = program.getSyntacticDiagnostics(source);
    const file = relativeToWorkingDirectory(source.fileName);
    // Without a list to record skips in (watch mode), invalid input still surfaces as an error.
    if (syntaxErrors.length && !skippedFiles) throw new Error(syntaxErrors.map(diagnosticText).join('\n'));
    if (syntaxErrors.length) {
      const reason = diagnosticText(syntaxErrors[0]);
      recordSkippedFile(skippedFiles, { file, reason }, `${reason} Skipped that file, which does not parse.`);
      continue;
    }
    collectUnresolvedPackages(program, source, unresolvedPackages);
    for (const analyzer of analyzers) {
      // One failing analyzer must not hide the findings of the other files or analyzers.
      let analyzerFindings;
      try {
        analyzerFindings = analyzer.analyzeFile(program, source, policy, forEachSourceCandidate);
      } catch (error) {
        if (!skippedFiles) throw error;
        recordSkippedFile(
          skippedFiles,
          { file, reason: error.message },
          `The ${analyzer.pillar} analysis of ${file} failed (${error.message}). Skipped that file for that analyzer.`,
        );
        continue;
      }
      for (const finding of analyzerFindings) {
        finding.file = relativeToWorkingDirectory(finding.file ?? source.fileName);
        if (analyzers.length > 1) finding.pillar = analyzer.pillar;
        findings.push(finding);
      }
    }
    // Symlinked entry paths can resolve their relative imports differently.
    scanned.add(canonicalFileName(path.resolve(directory, source.fileName)));
    localFiles.add(source);
  }
  return { scannedFiles: scanned.size, findings: findings.sort(compareFindings) };
}

// `project` is one config or an array of them. `onlyFiles` limits the roots of each config to the changed files;
// imports still resolve through the config.
function analyzeSources({ project, files, policy, onlyFiles, analyzers }) {
  const findings = [];
  const scanned = new Set();
  const configs = new Set();
  const notedBases = new Set();
  // Folders scanned with a config that leaves JavaScript out.
  const scopesWithoutJs = new Set();
  const referenceFindings = new Map();
  const unresolvedPackages = new Set();
  const skippedFiles = [];
  const probes = {
    fileExists: cachePathTest(ts.sys.fileExists),
    directoryExists: cachePathTest(ts.sys.directoryExists),
    readFile: cacheFileText(ts.sys.readFile),
  };
  const findWorkspaceEntry = cacheWorkspaceEntries();
  let sharedLibs;
  // Findings merge and schema tooling follow project references, not mere lib sharing.
  let usesReferences = false;
  const entries = files.length ? [] : scanEntries(project);
  const workspacePackages = entries.length ? workspacePackagesAround(path.dirname(entries[0].config)) : undefined;
  // Several configs can include the same file, which must report once.
  const sharesFilesAcrossConfigs = [project].flat().length > 1;
  const mergesFindings = sharesFilesAcrossConfigs || entries.some(({ companion }) => companion);

  function createSharedLibs() {
    return {
      registry: ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, ts.sys.getCurrentDirectory(), docMode),
      snapshots: new Map(),
    };
  }
  // Every program re-parses the lib.*.d.ts files unless several configs share them.
  if (entries.length > 1 || sharesFilesAcrossConfigs) sharedLibs = createSharedLibs();

  // `analyzes` picks the roots to report on; the others still load for types.
  function scan(roots, options, analyzes = () => true) {
    const inputs = roots.filter((filename) => isSourceInput(filename) && analyzes(filename));
    if (!inputs.length) return;
    const settings = { ...options, ...analysisOptions };
    const program = ts.createProgram(
      roots,
      settings,
      createHost(settings, sharedLibs, probes, workspacePackages, findWorkspaceEntry),
    );
    if (!files.length && !onlyFiles && !usesReferences && !sharesFilesAcrossConfigs) enableSchemaTooling(program);
    const { findings: programFindings } = analyzeProgram(
      program,
      inputs,
      scanned,
      policy,
      undefined,
      unresolvedPackages,
      analyzers,
      skippedFiles,
    );
    for (const finding of programFindings) {
      if (usesReferences || mergesFindings) {
        const key = JSON.stringify([
          canonicalFileName(finding.file),
          finding.line,
          finding.column,
          finding.ruleId,
          finding.message,
        ]);
        mergeFinding(referenceFindings, key, finding);
      } else findings.push(finding);
    }
  }

  function visitConfig(filename, scope, companion) {
    const canonical = fs.realpathSync(filename);
    if (configs.has(canonical)) return;
    configs.add(canonical);
    const parsed = ts.getParsedCommandLineOfConfigFile(
      filename,
      {},
      {
        ...ts.sys,
        ...probes,
        onUnRecoverableConfigFileDiagnostic(diagnostic) {
          throw new Error(diagnosticText(diagnostic));
        },
      },
    );
    if (!parsed) throw new Error('Unable to read project: ' + filename);
    const missingBases = uninstalledBaseConfigs(parsed);
    const configErrors = parsed.errors.filter((diagnostic) => !missingBases.includes(diagnostic));
    if (configErrors.length) throw new Error(configErrors.map(diagnosticText).join('\n'));
    for (const diagnostic of missingBases) {
      // Referenced projects usually share their bases, so each missing base is noted once.
      const base = missingPackageBase(diagnostic);
      if (notedBases.has(base)) continue;
      notedBases.add(base);
      console.error(
        `Note: ${diagnosticText(diagnostic)} Checked with this config's own settings until it is installed.`,
      );
    }
    if (parsed.projectReferences?.length) {
      usesReferences = true;
      sharedLibs ??= createSharedLibs();
    }
    for (const reference of parsed.projectReferences ?? []) {
      visitConfig(resolveConfig(ts.resolveProjectReferencePath(reference)), scope);
    }
    if (!parsed.options.allowJs && !onlyFiles) scopesWithoutJs.add(scope ?? path.dirname(filename));
    // The companion jsconfig only adds what the tsconfig left out.
    const isNew = (filename) => !companion || !scanned.has(canonicalFileName(path.resolve(filename)));
    scan(
      onlyFiles ? parsed.fileNames.filter(onlyFiles) : parsed.fileNames,
      parsed.options,
      (filename) => isInScope(scope, filename) && isNew(filename),
    );
  }

  if (files.length) {
    const paths = files.map((filename) => {
      if (!ts.sys.fileExists(filename) || !isSourceInput(filename)) {
        throw new Error('Expected an existing JS or TS source file: ' + filename);
      }
      return path.resolve(filename);
    });
    scan(paths, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      allowJs: true,
      checkJs: false,
      skipLibCheck: true,
      jsx: ts.JsxEmit.Preserve,
      ...(policy && { strictNullChecks: true }),
    });
  } else {
    for (const { config, scope, companion } of entries) visitConfig(config, scope, companion);
  }
  if (!scanned.size && !onlyFiles && !skippedFiles.length)
    throw new Error('No JavaScript or TypeScript source files to check.');
  require('./unscanned-javascript.cjs').noteUnscannedJavaScript(scopesWithoutJs, (filename) =>
    scanned.has(canonicalFileName(filename)),
  );
  for (const packageName of unresolvedPackages) console.error(formatMissingPackagesNote(packageName));
  const uninstalled = new Set();
  for (const scope of new Set(entries.map(({ config, scope }) => scope ?? path.dirname(config)))) {
    collectUninstalledDependencies(scope, workspacePackages, uninstalled);
  }
  for (const packageName of uninstalled) {
    if (!unresolvedPackages.has(packageName)) console.error(formatUninstalledDependencyNote(packageName));
  }
  for (const finding of referenceFindings.values()) findings.push(finding);
  return {
    scannedFiles: scanned.size,
    findings: findings.sort(compareFindings),
    ...(skippedFiles.length && { skippedFiles }),
  };
}

module.exports = {
  analysisOptions,
  analyzeProgram,
  analyzeSources,
  diagnosticText,
  resolveConfig,
  performanceAnalyzers,
};
