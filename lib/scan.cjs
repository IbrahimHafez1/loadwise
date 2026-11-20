'use strict';

const path = require('node:path');
const ts = require('typescript');
const { listFiles, createResolver } = require('./inputs.cjs');
const { createDuplicateIndex, generatedSource } = require('./duplicates.cjs');
const { archivedCopies, sourceContext } = require('./snapshot-context.cjs');
const { analyzeFunctions } = require('./functions.cjs');
const { collectEdges, checkGraph } = require('./architecture.cjs');
const { checkPlacement } = require('./layout.cjs');
const { nonJsLanguages, analyzePolyglot } = require('./polyglot.cjs');

async function scan(root, policy) {
  const inventory = listFiles(root, policy.exclude);
  const jsFiles = inventory.filter(file => /\.[cm]?[jt]sx?$/i.test(file) && !/\.d\.[cm]?ts$/i.test(file));
  const otherSources = inventory.filter(file => Object.hasOwn(nonJsLanguages, path.extname(file).toLowerCase()));
  if (!jsFiles.length && !otherSources.length && !policy.placement.length) {
    throw new Error('No supported source files or placement rules in this directory. Use --graph for a dependency graph from another language.');
  }
  const resolve = createResolver(root, new Set(jsFiles));
  const duplicates = createDuplicateIndex();
  const edges = [];
  const findings = checkPlacement(inventory, policy.placement);
  const languageCounts = {};
  const generated = new Set();
  for (const file of jsFiles) {
    const filename = path.join(root, file);
    const text = ts.sys.readFile(filename);
    if (text === undefined) throw new Error('Unable to read source: ' + file);
    const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
    if (generatedSource(source, file)) generated.add(file);
    const [error] = source.parseDiagnostics;
    if (error) {
      const where = source.getLineAndCharacterOfPosition(error.start ?? 0);
      throw new Error(file + ':' + (where.line + 1) + ':' + (where.character + 1) + ' ' +
        ts.flattenDiagnosticMessageText(error.messageText, '\n'));
    }
    const language = /\.[cm]?tsx?$/i.test(file) ? 'TypeScript' : 'JavaScript';
    languageCounts[language] = (languageCounts[language] ?? 0) + 1;
    duplicates.add(source, file);
    for (const finding of analyzeFunctions(source, file)) findings.push(finding);
    for (const edge of collectEdges(source, file, resolve, resolve.optionsFor(filename))) edges.push(edge);
  }
  const polyglot = await analyzePolyglot({root, files: otherSources});
  for (const finding of polyglot.findings) findings.push(finding);
  for (const finding of duplicates.findings()) findings.push(finding);
  for (const finding of checkGraph({files: jsFiles, edges, boundaries: policy.boundaries})) findings.push(finding);
  const snapshots = archivedCopies([...jsFiles, ...otherSources]);
  for (const finding of findings) {
    const reason = finding.contextualReason || sourceContext(finding, snapshots, generated);
    if (reason) finding.contextualReason = reason;
  }
  return { mode: 'source', discoveredFiles: inventory.length, scannedFiles: jsFiles.length + otherSources.length,
    dependencyFiles: jsFiles.length,
    placementFiles: policy.placement.length ? inventory.length : 0, resolvedInternalEdges: edges.length,
    languageCounts: {...languageCounts, ...polyglot.languageCounts}, findings };
}

module.exports = { scan };
