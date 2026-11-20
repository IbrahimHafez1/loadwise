'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { analyzeFile } = require('./analyze.cjs');

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

function analyzeProgram(
  program,
  inputs = program.getRootFileNames(),
  scanned = new Set(),
  policy,
  forEachSourceCandidate,
) {
  const optionErrors = program.getOptionsDiagnostics();
  if (optionErrors.length) throw new Error(optionErrors.map(diagnosticText).join('\n'));
  const findings = [];
  const localFiles = new Set();
  const directory = program.getCurrentDirectory();
  for (const filename of inputs.filter(isSourceInput)) {
    const source = program.getSourceFile(filename);
    if (!source) throw new Error('Unable to load source: ' + filename);
    if (localFiles.has(source)) continue;
    const syntaxErrors = program.getSyntacticDiagnostics(source);
    if (syntaxErrors.length) throw new Error(syntaxErrors.map(diagnosticText).join('\n'));
    const relativePath = path.relative(process.cwd(), source.fileName).split(path.sep).join('/');
    for (const finding of analyzeFile(program, source, policy, forEachSourceCandidate)) {
      finding.file = relativePath;
      findings.push(finding);
    }
    // Symlinked entry paths can resolve their relative imports differently.
    scanned.add(canonicalFileName(path.resolve(directory, source.fileName)));
    localFiles.add(source);
  }
  return { scannedFiles: scanned.size, findings: findings.sort(compareFindings) };
}

// `onlyFiles` limits the roots of each config to the changed files; imports still resolve through the config.
function analyzeSources({ project, files, policy, onlyFiles }) {
  const findings = [];
  const scanned = new Set();
  const configs = new Set();
  const referenceFindings = new Map();
  const probes = {
    fileExists: cachePathTest(ts.sys.fileExists),
    directoryExists: cachePathTest(ts.sys.directoryExists),
  };
  let sharedLibs;

  function scan(roots, options) {
    if (!roots.some(isSourceInput)) return;
    const settings = { ...options, ...analysisOptions };
    const program = ts.createProgram(roots, settings, createHost(settings, sharedLibs, probes));
    for (const finding of analyzeProgram(program, roots, scanned, policy).findings) {
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
    if (parsed.errors.length) throw new Error(parsed.errors.map(diagnosticText).join('\n'));
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
  for (const finding of referenceFindings.values()) findings.push(finding);
  return { scannedFiles: scanned.size, findings: findings.sort(compareFindings) };
}

module.exports = { analysisOptions, analyzeProgram, analyzeSources, diagnosticText, resolveConfig };
