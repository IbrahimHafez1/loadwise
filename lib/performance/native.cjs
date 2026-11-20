'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { compareFindings, isSourceInput, mergeFinding, resolveConfig } = require('./source-inputs.cjs');
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
  const visitedConfigs = new Set();
  const scanned = new Set();
  const findings = new Map();
  const canonical = (filename) => api.getCanonicalFileName(path.resolve(filename));

  function checkErrors(diagnostics) {
    if (diagnostics?.length) {
      throw new Error(binding.formatDiagnostics(diagnostics, api).trim());
    }
  }

  function checkConfig(diagnostics) {
    if (fallback && diagnostics?.length) {
      throw new IncompatibleProject([...new Set(diagnostics.map((diagnostic) => diagnostic.text))].join(' '));
    }
    checkErrors(diagnostics);
  }

  function scan(roots, options) {
    const inputs = roots.filter(isSourceInput);
    const program = api.createProgram(roots, { ...options, noEmit: true });
    try {
      checkErrors(program.getProgramDiagnostics());
      // The native service accepts an array, saving a round-trip per input.
      checkErrors(program.getSyntacticDiagnostics(inputs));
      const adapter = adaptProgram(program, options);
      const localFiles = new Set();
      for (const filename of inputs) {
        const source = program.getSourceFile(filename);
        if (!source) throw new Error('Unable to load source: ' + filename);
        if (localFiles.has(source)) continue;
        localFiles.add(source);
        const relativePath = path.relative(process.cwd(), source.fileName).split(path.sep).join('/');
        const key = canonical(source.fileName);
        scanned.add(key);
        for (const finding of analyzeFile(adapter, source, policy)) {
          finding.file = relativePath;
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
  function visitConfig(filename, projects) {
    // realpath resolves the reference even before the native API initializes.
    const key = fs.realpathSync.native(filename);
    if (visitedConfigs.has(key)) return;
    visitedConfigs.add(key);
    const parsed = api.parseConfigFile(filename);
    checkConfig(parsed.errors);
    for (const reference of parsed.projectReferences ?? []) visitConfig(resolveConfig(reference.path), projects);
    const rootFiles = onlyFiles ? parsed.fileNames.filter(onlyFiles) : parsed.fileNames;
    if (!rootFiles.some(isSourceInput)) return;
    // Option diagnostics do not depend on root files, so an empty program reports them cheaply.
    const optionsProgram = api.createProgram([], { ...parsed.options, noEmit: true });
    try {
      checkConfig(optionsProgram.getProgramDiagnostics());
    } finally {
      optionsProgram.dispose();
    }
    projects.push([rootFiles, parsed.options]);
  }

  function selectSyntax() {
    selectNativeSyntax(require('./native-syntax.cjs'));
    ({ adaptProgram } = require('./native-checker.cjs'));
    ({ analyzeFile } = require('./analyze.cjs'));
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
      ]);
    } else {
      for (const config of [project ?? '.'].flat()) visitConfig(resolveConfig(config), projects);
    }
    selectSyntax();
    for (const [roots, options] of projects) scan(roots, options);
    if (!scanned.size && !onlyFiles) throw new Error('No JavaScript or TypeScript source files to check.');
    return { scannedFiles: scanned.size, findings: [...findings.values()].sort(compareFindings) };
  } catch (error) {
    if (error instanceof IncompatibleProject) return { fallback: true, reason: error.message };
    throw error;
  } finally {
    api.close();
  }
}

module.exports = { analyzeNative };
