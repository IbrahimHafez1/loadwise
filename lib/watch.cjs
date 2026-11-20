'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { analyzeProgram, diagnosticText, resolveConfig } = require('./projects.cjs');

function watchProject(configPath, { onResult, onError, policySource }) {
  const config = resolveConfig(configPath ?? '.');
  const reportDiagnostic = diagnostic => onError(new Error(diagnosticText(diagnostic)));
  const host = ts.createWatchCompilerHost(
    config, { noEmit: true }, ts.sys, ts.createAbstractBuilder, reportDiagnostic, () => {},
  );
  host.jsDocParsingMode = ts.JSDocParsingMode.ParseForTypeErrors;
  host.trace = () => {};
  // Keep the config watcher alive if an editor temporarily removes the project file.
  const readFile = host.readFile;
  host.readFile = filename => readFile(filename) ?? (path.resolve(filename) === config ? '{"files":[]}' : undefined);
  let program;
  const candidatesByFile = new WeakMap();
  function forEachSourceCandidate(sourceFile, checkNode) {
    let candidates = candidatesByFile.get(sourceFile);
    if (!candidates) {
      candidates = [];
      function collect(node) {
        if (ts.isCallExpression(node) || ts.isNewExpression(node) ||
            (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)) candidates.push(node);
        ts.forEachChild(node, collect);
      }
      collect(sourceFile);
      candidatesByFile.set(sourceFile, candidates);
    }
    // The syntax tree can be shared across edits. Types and findings belong to the current program.
    for (const node of candidates) checkNode(node);
  }
  function refresh() {
    if (!program) return;
    let result;
    try {
      if (!ts.sys.fileExists(config)) throw new Error('Project config does not exist: ' + config);
      if (program.getProjectReferences()?.length) {
        throw new Error('Watch a leaf project with -p. This config contains project references.');
      }
      const configErrors = program.getConfigFileParsingDiagnostics();
      if (configErrors.length) throw new Error(configErrors.map(diagnosticText).join('\n'));
      result = analyzeProgram(program, undefined, undefined, policySource?.read(), forEachSourceCandidate);
      if (!result.scannedFiles) throw new Error('No JavaScript or TypeScript source files to check.');
    } catch (error) {
      onError(error);
      return;
    }
    onResult(result);
  }
  host.afterProgramCreate = builder => {
    program = builder.getProgram();
    refresh();
  };
  // Poll this single optional input so atomic replacements and newly created paths keep the same watcher.
  function policyChanged(current, previous) {
    if (current.nlink || previous.nlink) refresh();
  }
  if (policySource) fs.watchFile(policySource.filename, { interval: 250 }, policyChanged);
  function unwatchPolicy() {
    if (policySource) fs.unwatchFile(policySource.filename, policyChanged);
  }
  let watcher;
  try {
    watcher = ts.createWatchProgram(host);
  } catch (error) {
    unwatchPolicy();
    throw error;
  }
  return {
    ...watcher,
    close() {
      unwatchPolicy();
      watcher.close();
    }
  };
}

module.exports = { watchProject };
