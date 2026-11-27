import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { syntaxError, compatibilityMatch, retryCompatibility } from '../shared/polyglot-compatibility.js';
import type { Finding } from '../shared/types.js';
import type { AstGrepMatch } from './types/ast-grep-match.js';

interface PolyglotFinding extends Finding {
  file: string;
  line: number;
  column: number;
}

interface PolyglotScan {
  scannedFiles: number;
  skippedFiles: number;
  findings: PolyglotFinding[];
}

// fs.promises.realpath is the JS implementation; only the native one keeps Windows casing.
const realpathNative = promisify(fs.realpath.native);

const configByPillar = {
  performance: path.resolve(import.meta.dirname, '../../polyglot/performance/sgconfig.yml'),
  reliability: path.resolve(import.meta.dirname, '../../polyglot/reliability/sgconfig.yml'),
};
const extensions = new Set(['.py', '.go', '.java', '.cs', '.rs']);
const excludedDirectories =
  '!**/{node_modules,dist,build,coverage,.next,.nuxt,.venv,venv,__pycache__,.cache,.turbo,target,vendor,.worktrees}';

async function retryRules(configPath: string, language: string) {
  const name = language.toLowerCase();
  // A rule set may cover fewer languages than the scan globs, so a language without rules retries the parse check alone.
  const rule = await fs.promises
    .readFile(path.join(path.dirname(configPath), 'rules', name + '.yml'), 'utf8')
    .catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
      throw error;
    });
  const error = {
    id: 'polyglot-parse-error-' + name,
    language,
    severity: 'warning',
    rule: { kind: 'ERROR' },
    message: 'The parser encountered invalid or unsupported syntax.',
  };
  return rule + '\n---\n' + JSON.stringify(error);
}

function finding(file: string, match: AstGrepMatch): PolyglotFinding {
  const { line: row, column } = match.range.start;
  return { file, line: row + 1, column: column + 1, ruleId: match.ruleId, message: match.message };
}

export async function resolveAstGrepBinary(): Promise<string | undefined> {
  try {
    const postinstall = await import('@ast-grep/cli/postinstall.js');
    return postinstall.resolveBinaryPath() || undefined;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') return undefined;
    throw error;
  }
}

async function resolveInputs(paths: readonly string[]): Promise<{ inputs: Set<string>; explicitFiles: Set<string> }> {
  const inputs = new Set<string>();
  const explicitFiles = new Set<string>();
  for (const requested of new Set(paths)) {
    let input = path.resolve(requested);
    const stat = await fs.promises.stat(input).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
      throw error;
    });
    if (!stat) throw new Error('Polyglot input does not exist: ' + input);
    if (!stat.isDirectory() && !(stat.isFile() && extensions.has(path.extname(input).toLowerCase()))) {
      throw new Error('Expected a directory or a .py, .go, .java, .cs or .rs file: ' + input);
    }
    if (process.platform === 'win32') {
      // Preserve symlinks and distinct entries in case-sensitive directories.
      const actual = await realpathNative(input);
      if (actual.toLowerCase() === input.toLowerCase()) input = actual;
    }
    inputs.add(input);
    if (stat.isFile()) explicitFiles.add(input);
  }
  return { inputs, explicitFiles };
}

async function finalizePolyglotFindings(
  binary: string,
  configPath: string,
  findings: PolyglotFinding[],
  evidence: ReadonlyMap<string, AstGrepMatch[]>,
): Promise<PolyglotFinding[]> {
  const retriedFiles = new Set<string>();
  const recoveredFindings: PolyglotFinding[] = [];
  for (const [file, matches] of evidence) {
    const error = matches.find(syntaxError);
    if (!error) continue;
    const retry = await retryCompatibility(
      binary,
      configPath,
      (language) => retryRules(configPath, language),
      path.resolve(file),
      matches,
    );
    if (!retry) {
      const { line, column, message } = finding(file, error);
      throw new Error(`${file}:${line}:${column}: ${message}`);
    }
    retriedFiles.add(file);
    for (const match of retry) recoveredFindings.push(finding(file, match));
  }
  const completeFindings = retriedFiles.size
    ? findings.filter((match) => !retriedFiles.has(match.file)).concat(recoveredFindings)
    : findings;
  completeFindings.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.ruleId.localeCompare(right.ruleId),
  );
  // Explicit files can overlap with a directory passed on the same command line.
  return completeFindings.filter((entry, index) => {
    const previous = completeFindings[index - 1];
    return (
      !previous ||
      previous.file !== entry.file ||
      previous.line !== entry.line ||
      previous.column !== entry.column ||
      previous.ruleId !== entry.ruleId
    );
  });
}

async function scanPolyglot(configPath: string, paths: readonly string[]): Promise<PolyglotScan> {
  if (!paths.length) throw new Error('Pass at least one source file or directory to polyglot.');
  const { inputs, explicitFiles } = await resolveInputs(paths);
  const binary = await resolveAstGrepBinary();
  if (!binary) {
    process.stderr.write('Note: @ast-grep/cli is not installed; skipping polyglot checks.\n');
    return { scannedFiles: 0, skippedFiles: 0, findings: [] };
  }
  const child = spawn(
    binary,
    [
      'scan',
      '--config',
      configPath,
      '--custom-languages',
      'ignore',
      '--json=stream',
      '--inspect=entity',
      '--globs',
      excludedDirectories,
      '--',
      ...inputs,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  const findings: PolyglotFinding[] = [];
  const evidence = new Map<string, AstGrepMatch[]>();
  const scanned = new Set<string>();
  let finished = false;
  let failure: string | undefined;
  async function readMatches() {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      const match: AstGrepMatch = JSON.parse(line);
      const file = path.relative(process.cwd(), match.file).split(path.sep).join('/');
      if (!compatibilityMatch(match)) findings.push(finding(file, match));
      else {
        if (!evidence.has(file)) evidence.set(file, []);
        evidence.get(file)?.push(match);
      }
    }
  }
  async function readScanStatus() {
    for await (const line of createInterface({ input: child.stderr, crlfDelay: Infinity })) {
      const file = line.match(/^sg: entity\|file\|(.+): (language=\w+,appliedRuleCount=\d+|skipped=\w+)$/);
      if (file) {
        if (file[2].startsWith('language=') || file[2] === 'skipped=emptyFile') scanned.add(path.resolve(file[1]));
        else failure ||= 'Could not scan ' + file[1] + ' (' + file[2] + ').';
      } else if (/^sg: summary\|file: scannedFileCount=\d+,skippedFileCount=\d+/.test(line)) {
        finished = true;
      } else if (!line.startsWith('sg: ')) {
        failure ||= line.trim();
      }
    }
  }
  try {
    const [[code, signal]] = await Promise.all([once(child, 'close'), readMatches(), readScanStatus()]);
    if (code !== 0 || failure) throw new Error(failure || 'ast-grep failed: ' + (signal ?? code));
    if (!finished) throw new Error('ast-grep did not report a scan summary.');
    for (const input of explicitFiles) {
      if (!scanned.has(input)) throw new Error('No polyglot scan result for explicit source file: ' + input);
    }
    if (!scanned.size) throw new Error('No supported source files were scanned.');
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    throw error;
  }
  const unique = await finalizePolyglotFindings(binary, configPath, findings, evidence);
  return { scannedFiles: scanned.size, skippedFiles: 0, findings: unique };
}

/** Run the ast-grep polyglot performance or reliability checks on the given files or directories. */
async function checkPolyglot(
  paths: readonly string[],
  pillar: keyof typeof configByPillar = 'performance',
): Promise<PolyglotScan> {
  return scanPolyglot(configByPillar[pillar], paths);
}

export { checkPolyglot, scanPolyglot };
export type { PolyglotFinding, PolyglotScan };
