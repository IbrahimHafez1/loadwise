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
  selectNativeSyntax(require('./native-syntax.cjs'));
  return { api: new binding.API({ tsserverPath }), binding };
}

function analyzeNative({ project, files = [], policy }) {
  const { api, binding } = openCompiler();
  const { adaptProgram } = require('./native-checker.cjs');
  const { analyzeFile } = require('./analyze.cjs');
  const visitedConfigs = new Set();
  const scanned = new Set();
  const findings = new Map();
  const canonical = (filename) => api.getCanonicalFileName(path.resolve(filename));

  function checkErrors(diagnostics) {
    if (diagnostics?.length) {
      throw new Error(binding.formatDiagnostics(diagnostics, api).trim());
    }
  }

  function scan(roots, options) {
    const inputs = roots.filter(isSourceInput);
    if (!inputs.length) return;
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

  function visitConfig(filename) {
    // realpath resolves the reference even before the native API initializes.
    const key = fs.realpathSync.native(filename);
    if (visitedConfigs.has(key)) return;
    visitedConfigs.add(key);
    const parsed = api.parseConfigFile(filename);
    checkErrors(parsed.errors);
    for (const reference of parsed.projectReferences ?? []) visitConfig(resolveConfig(reference.path));
    scan(parsed.fileNames, parsed.options);
  }

  try {
    if (files.length) {
      const roots = files.map((filename) => {
        if (!isSourceInput(filename) || !fs.statSync(filename, { throwIfNoEntry: false })?.isFile()) {
          throw new Error('Expected an existing JS or TS source file: ' + filename);
        }
        return path.resolve(filename);
      });
      const { ScriptTarget } = requireNative('typescript/ast');
      scan(roots, {
        target: ScriptTarget.ES2022,
        module: binding.ModuleKind.NodeNext,
        allowJs: true,
        checkJs: false,
        skipLibCheck: true,
        jsx: binding.JsxEmit.Preserve,
        ...(policy && { strictNullChecks: true }),
      });
    } else {
      visitConfig(resolveConfig(project ?? '.'));
    }
    if (!scanned.size) throw new Error('No JavaScript or TypeScript source files to check.');
    return { scannedFiles: scanned.size, findings: [...findings.values()].sort(compareFindings) };
  } finally {
    api.close();
  }
}

module.exports = { analyzeNative };
