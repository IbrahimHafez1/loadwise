'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  compareFindings,
  isInScope,
  isSourceInput,
  mergeFinding,
  scanEntries,
  relativeToWorkingDirectory,
  resolveConfig,
} = require('./source-inputs.cjs');
const { selectNativeSyntax } = require('./compiler.cjs');
const { requireNative, executable } = require('./native-runtime.cjs');

function openCompiler() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('--native requires Node.js 22.13 or newer.');
  const tsserverPath = executable();
  const binding = requireNative('typescript/sync');
  return { api: new binding.API({ tsserverPath }), binding };
}

// Raised only in fallback mode, while the process can still switch to the JS compiler.
class IncompatibleProject extends Error {}

// TypeScript's "Cannot find type definition file for '{0}'." diagnostic.
const missingTypeLibraryCode = 2688;
// TypeScript's "File '{0}' not found." diagnostic.
const missingFileCode = 6053;

// The package a missing `extends` names; relative and absolute paths are the project's own mistakes.
function missingPackageBase(diagnostic) {
  if (diagnostic.code !== missingFileCode) return undefined;
  const missing = /'([^']+)'/.exec(diagnostic.text)?.[1];
  return missing !== undefined && !/^(?:\.|\/|[a-z]:)/i.test(missing) ? missing : undefined;
}

// TypeScript 7 removed `baseUrl`, so its mapping moves into `paths`, as in the TypeScript 7 migration.
// The parser has already resolved `baseUrl` against the config that declared it, even through `extends`,
// and earlier compilers resolve every `paths` target against it; absolute targets keep that meaning
// wherever `paths` was declared. Bare imports that match no pattern still looked in `baseUrl`, which a
// catch-all pattern keeps, since the longest matching pattern wins. The config on disk is left untouched.
function withoutBaseUrl(options) {
  if (options.baseUrl === undefined) return options;
  const { baseUrl, ...rest } = options;
  const fromBaseUrl = (target) => path.resolve(baseUrl, target).replaceAll('\\', '/');
  const paths = { '*': [fromBaseUrl('*')] };
  for (const [pattern, targets] of Object.entries(options.paths ?? {})) paths[pattern] = targets.map(fromBaseUrl);
  return { ...rest, paths };
}

// With fallback, an unavailable compiler or a rejected config returns { fallback: true, reason }
// before the native syntax is selected, so the caller can run the JS engine in this process.
// `project` is one config or an array of them. `onlyFiles` limits the roots of each config to the changed files;
// imports still resolve through the config.
function analyzeNative({ project, files = [], policy, fallback = false, onlyFiles }) {
  let compiler;
  try {
    compiler = openCompiler();
  } catch (error) {
    if (fallback) return { fallback: true };
    throw error;
  }
  const { api, binding } = compiler;
  let adaptProgram;
  let analyzeFile;
  let enableSchemaTooling;
  const visitedConfigs = new Set();
  // Folders scanned with a config that leaves JavaScript out.
  const scopesWithoutJs = new Set();
  const scanned = new Set();
  const findings = new Map();
  const canonical = (filename) => api.getCanonicalFileName(path.resolve(filename));

  // A `types` entry that is not installed leaves only those globals unresolved, as in the TypeScript engine.
  const reportedTypeLibraries = new Set();
  function withoutMissingTypeLibraries(diagnostics = []) {
    const missing = diagnostics.filter((diagnostic) => diagnostic.code === missingTypeLibraryCode);
    const names = missing
      .map((diagnostic) => /'([^']+)'/.exec(diagnostic.text)?.[1])
      .filter((name) => name && !reportedTypeLibraries.has(name));
    if (names.length) {
      names.forEach((name) => reportedTypeLibraries.add(name));
      console.error(`Note: type libraries not installed (${names.join(', ')}); analysis continued without them.`);
    }
    return diagnostics.filter((diagnostic) => diagnostic.code !== missingTypeLibraryCode);
  }

  function checkErrors(diagnostics) {
    diagnostics = withoutMissingTypeLibraries(diagnostics);
    if (diagnostics.length) {
      throw new Error(binding.formatDiagnostics(diagnostics, api).trim());
    }
  }

  // An `extends` naming a package that is not installed leaves the config's own settings, as in the TypeScript engine.
  const notedBases = new Set();
  function withoutMissingPackageBases(diagnostics = []) {
    const isMissingBase = (diagnostic) => missingPackageBase(diagnostic) !== undefined;
    for (const diagnostic of diagnostics.filter(isMissingBase)) {
      // Referenced projects usually share their bases, so each missing base is noted once.
      const base = missingPackageBase(diagnostic);
      if (notedBases.has(base)) continue;
      notedBases.add(base);
      const { line, character } = diagnostic.startPosition;
      const location = `${path.resolve(diagnostic.fileName)}(${line + 1},${character + 1})`;
      console.error(
        `Note: ${location} ${diagnostic.text} Checked with this config's own settings until it is installed.`,
      );
    }
    return diagnostics.filter((diagnostic) => !isMissingBase(diagnostic));
  }

  function checkConfig(diagnostics) {
    diagnostics = withoutMissingTypeLibraries(withoutMissingPackageBases(diagnostics));
    if (fallback && diagnostics?.length) {
      throw new IncompatibleProject([...new Set(diagnostics.map((diagnostic) => diagnostic.text))].join(' '));
    }
    checkErrors(diagnostics);
  }

  // `analyzes` picks the roots to report on; the others still load for types.
  function scan(roots, options, analyzes) {
    const inputs = roots.filter((filename) => isSourceInput(filename) && analyzes(filename));
    if (!inputs.length) return;
    const program = api.createProgram(roots, { ...options, noEmit: true });
    try {
      checkErrors(program.getProgramDiagnostics());
      // The native service accepts an array, saving a round-trip per input.
      checkErrors(program.getSyntacticDiagnostics(inputs));
      const adapter = adaptProgram(program, options);
      if (!files.length && !onlyFiles && visitedConfigs.size === 1) enableSchemaTooling(adapter);
      const localFiles = new Set();
      for (const filename of inputs) {
        const source = program.getSourceFile(filename);
        if (!source) throw new Error('Unable to load source: ' + filename);
        if (localFiles.has(source)) continue;
        localFiles.add(source);
        const key = canonical(source.fileName);
        scanned.add(key);
        for (const finding of analyzeFile(adapter, source, policy)) {
          finding.file = relativeToWorkingDirectory(finding.file);
          mergeFinding(
            findings,
            JSON.stringify([key, finding.line, finding.column, finding.ruleId, finding.message]),
            finding,
          );
        }
      }
    } finally {
      program.dispose();
    }
  }

  // Collects every config with source inputs, in scan order, after validating its options.
  function visitConfig(filename, projects, scope, companion) {
    // realpath resolves the reference even before the native API initializes.
    const key = fs.realpathSync.native(filename);
    if (visitedConfigs.has(key)) return;
    visitedConfigs.add(key);
    const parsed = api.parseConfigFile(filename);
    checkConfig(parsed.errors);
    const options = withoutBaseUrl(parsed.options);
    for (const reference of parsed.projectReferences ?? []) {
      visitConfig(resolveConfig(reference.path), projects, scope);
    }
    if (!parsed.options.allowJs && !onlyFiles) scopesWithoutJs.add(scope ?? path.dirname(filename));
    const rootFiles = onlyFiles ? parsed.fileNames.filter(onlyFiles) : parsed.fileNames;
    if (!rootFiles.some((filename) => isSourceInput(filename) && isInScope(scope, filename))) return;
    // Option diagnostics do not depend on root files, so an empty program reports them cheaply.
    const optionsProgram = api.createProgram([], { ...options, noEmit: true });
    try {
      checkConfig(optionsProgram.getProgramDiagnostics());
    } finally {
      optionsProgram.dispose();
    }
    // The companion jsconfig only adds what the tsconfig left out; scans run in visit order.
    const isNew = (filename) => !companion || !scanned.has(canonical(filename));
    projects.push([rootFiles, options, (filename) => isInScope(scope, filename) && isNew(filename)]);
  }

  function selectSyntax() {
    selectNativeSyntax(require('./native-syntax.cjs'));
    ({ adaptProgram } = require('./native-checker.cjs'));
    ({ analyzeFile } = require('./analyze.cjs'));
    ({ enableSchemaTooling } = require('./schema-tooling.cjs'));
  }

  try {
    const projects = [];
    if (files.length) {
      const roots = files.map((filename) => {
        if (!isSourceInput(filename) || !fs.statSync(filename, { throwIfNoEntry: false })?.isFile()) {
          throw new Error('Expected an existing JS or TS source file: ' + filename);
        }
        return path.resolve(filename);
      });
      const { ScriptTarget } = requireNative('typescript/ast');
      projects.push([
        roots,
        {
          target: ScriptTarget.ES2022,
          module: binding.ModuleKind.NodeNext,
          allowJs: true,
          checkJs: false,
          skipLibCheck: true,
          jsx: binding.JsxEmit.Preserve,
          ...(policy && { strictNullChecks: true }),
        },
        () => true,
      ]);
    } else {
      for (const { config, scope, companion } of scanEntries(project)) {
        visitConfig(config, projects, scope, companion);
      }
    }
    selectSyntax();
    for (const [roots, options, analyzes] of projects) scan(roots, options, analyzes);
    if (!scanned.size && !onlyFiles) throw new Error('No JavaScript or TypeScript source files to check.');
    require('./unscanned-javascript.cjs').noteUnscannedJavaScript(scopesWithoutJs, (filename) =>
      scanned.has(canonical(filename)),
    );
    return { scannedFiles: scanned.size, findings: [...findings.values()].sort(compareFindings) };
  } catch (error) {
    if (error instanceof IncompatibleProject) return { fallback: true, reason: error.message };
    throw error;
  } finally {
    api.close();
  }
}

module.exports = { analyzeNative };
