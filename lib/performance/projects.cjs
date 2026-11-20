'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { analyzeFile } = require('./analyze.cjs');
const { collectUnresolvedPackages, formatMissingPackagesNote } = require('./missing-packages.cjs');
const { compareFindings, isSourceInput, mergeFinding, resolveConfig } = require('./source-inputs.cjs');
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

function createHost(settings, sharedLibs, probes) {
  const host = ts.createCompilerHost(settings);
  Object.assign(host, probes);
  host.jsDocParsingMode = docMode;
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

// A base config from a package (`"extends": "@org/tsconfig/base.json"`) is missing until dependencies are installed.
// A missing relative base is a real configuration mistake and stays fatal.
function uninstalledBaseConfigs(parsed) {
  const packageBases = [parsed.raw?.extends]
    .flat()
    .filter((base) => typeof base === 'string' && !/^(?:\.|\/|[a-z]:)/i.test(base));
  return parsed.errors.filter(
    (diagnostic) =>
      diagnostic.code === missingFileCode &&
      packageBases.some((base) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ').includes(base)),
  );
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
    if (syntaxErrors.length) throw new Error(syntaxErrors.map(diagnosticText).join('\n'));
    collectUnresolvedPackages(program, source, unresolvedPackages);
    const relativePath = path.relative(process.cwd(), source.fileName).split(path.sep).join('/');
    for (const analyzer of analyzers) {
      for (const finding of analyzer.analyzeFile(program, source, policy, forEachSourceCandidate)) {
        finding.file = relativePath;
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

// `onlyFiles` limits the roots of each config to the changed files; imports still resolve through the config.
function analyzeSources({ project, files, policy, onlyFiles, analyzers }) {
  const findings = [];
  const scanned = new Set();
  const configs = new Set();
  const referenceFindings = new Map();
  const unresolvedPackages = new Set();
  const probes = {
    fileExists: cachePathTest(ts.sys.fileExists),
    directoryExists: cachePathTest(ts.sys.directoryExists),
  };
  let sharedLibs;

  function scan(roots, options) {
    if (!roots.some(isSourceInput)) return;
    const settings = { ...options, ...analysisOptions };
    const program = ts.createProgram(roots, settings, createHost(settings, sharedLibs, probes));
    const { findings: programFindings } = analyzeProgram(
      program,
      roots,
      scanned,
      policy,
      undefined,
      unresolvedPackages,
      analyzers,
    );
    for (const finding of programFindings) {
      if (sharedLibs) {
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

  function visitConfig(filename) {
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
      console.error(
        `Note: ${diagnosticText(diagnostic)} Checked with this config's own settings until it is installed.`,
      );
    }
    if (parsed.projectReferences?.length && !sharedLibs) {
      sharedLibs = {
        registry: ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, ts.sys.getCurrentDirectory(), docMode),
        snapshots: new Map(),
      };
    }
    for (const reference of parsed.projectReferences ?? []) {
      visitConfig(resolveConfig(ts.resolveProjectReferencePath(reference)));
    }
    scan(onlyFiles ? parsed.fileNames.filter(onlyFiles) : parsed.fileNames, parsed.options);
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
    visitConfig(resolveConfig(project ?? '.'));
  }
  if (!scanned.size && !onlyFiles) throw new Error('No JavaScript or TypeScript source files to check.');
  for (const packageName of unresolvedPackages) console.error(formatMissingPackagesNote(packageName));
  for (const finding of referenceFindings.values()) findings.push(finding);
  return { scannedFiles: scanned.size, findings: findings.sort(compareFindings) };
}

module.exports = {
  analysisOptions,
  analyzeProgram,
  analyzeSources,
  diagnosticText,
  resolveConfig,
  performanceAnalyzers,
};
