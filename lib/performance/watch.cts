import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { analysisOptions, analyzeProgram, diagnosticText, resolveConfig } from './projects.cjs';
import type { BuilderProgram, Diagnostic, Node, Program, SourceFile, WatchOfConfigFile } from 'typescript';
import type { PerformancePolicy } from './types/performance-policy.cjs';

/** The project policy file being watched, re-read on every refresh. */
interface WatchPolicySource {
  filename: string;
  read(): PerformancePolicy | undefined;
}

interface WatchCallbacks {
  onResult(result: ReturnType<typeof analyzeProgram>): void;
  onError(error: unknown): void;
  policySource?: WatchPolicySource;
}

type CandidateVisitor = (node: Node) => void;

function watchProject(configPath: string | undefined, { onResult, onError, policySource }: WatchCallbacks) {
  const config = resolveConfig(configPath ?? '.');
  const reportDiagnostic = (diagnostic: Diagnostic) => onError(new Error(diagnosticText(diagnostic)));
  const host = ts.createWatchCompilerHost(
    config,
    analysisOptions,
    ts.sys,
    ts.createAbstractBuilder,
    reportDiagnostic,
    () => {},
  );
  host.jsDocParsingMode = ts.JSDocParsingMode.ParseForTypeErrors;
  host.trace = () => {};
  // Keep the config watcher alive if an editor temporarily removes the project file.
  const readFile = host.readFile;
  host.readFile = (filename) => readFile(filename) ?? (path.resolve(filename) === config ? '{"files":[]}' : undefined);
  let program: Program | undefined;
  const candidatesByFile = new WeakMap<SourceFile, Node[]>();
  function forEachSourceCandidate(sourceFile: SourceFile, checkNode: CandidateVisitor): void {
    let candidates = candidatesByFile.get(sourceFile);
    if (!candidates) {
      const collected: Node[] = [];
      candidates = collected;
      function collect(node: Node): void {
        if (
          ts.isCallExpression(node) ||
          ts.isNewExpression(node) ||
          ts.isTaggedTemplateExpression(node) ||
          ts.isReturnStatement(node) ||
          ts.isPrefixUnaryExpression(node) ||
          (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        )
          collected.push(node);
        ts.forEachChild(node, collect);
      }
      collect(sourceFile);
      candidatesByFile.set(sourceFile, candidates);
    }
    // The syntax tree can be shared across edits. Types and findings belong to the current program.
    for (const node of candidates) checkNode(node);
  }
  function refresh(): void {
    if (!program) return;
    let result: ReturnType<typeof analyzeProgram>;
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
  host.afterProgramCreate = (builder) => {
    program = builder.getProgram();
    refresh();
  };
  // Poll this single optional input so atomic replacements and newly created paths keep the same
  // watcher.
  function policyChanged(current: fs.Stats, previous: fs.Stats): void {
    if (current.nlink || previous.nlink) refresh();
  }
  if (policySource) fs.watchFile(policySource.filename, { interval: 250 }, policyChanged);
  function unwatchPolicy(): void {
    if (policySource) fs.unwatchFile(policySource.filename, policyChanged);
  }
  let watcher: WatchOfConfigFile<BuilderProgram>;
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
    },
  };
}

export { watchProject };
