import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { syntaxError, compatibilityMatch, retryCompatibility } from '../shared/polyglot-compatibility.cjs';
import type { Finding } from '../shared/types.cjs';
import type { AstGrepMatch } from './types/ast-grep-match.cjs';
import * as postinstall from '@ast-grep/cli/postinstall.js';

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

const config = path.resolve(__dirname, '../../polyglot/performance/sgconfig.yml');
const extensions = new Set(['.py', '.go', '.java', '.cs', '.rs']);
const excludedDirectories =
  '!**/{node_modules,dist,build,coverage,.next,.nuxt,.venv,venv,__pycache__,.cache,.turbo,target,vendor,.worktrees}';

async function retryRules(language: string) {
  const name = language.toLowerCase();
  const rule = await fs.promises.readFile(path.join(path.dirname(config), 'rules', name + '.yml'), 'utf8');
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

function nativeBinary(): string {
  let binary: string | undefined;
  try {
    binary = postinstall.resolveBinaryPath();
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND')) throw error;
  }
  if (!binary)
    throw new Error(
      'Polyglot checks require the optional @ast-grep/cli native package for this platform. Install with npm install --include=optional.',
    );
  return binary;
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

async function checkPolyglot(paths: readonly string[]): Promise<PolyglotScan> {
  if (!paths.length) throw new Error('Pass at least one source file or directory to polyglot.');
  const { inputs, explicitFiles } = await resolveInputs(paths);
  const binary = nativeBinary();
  const child = spawn(
    binary,
    [
      'scan',
      '--config',
      config,
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
  const retriedFiles = new Set<string>();
  const recoveredFindings: PolyglotFinding[] = [];
  for (const [file, matches] of evidence) {
    const error = matches.find(syntaxError);
    if (!error) continue;
    const retry = await retryCompatibility(binary, config, retryRules, path.resolve(file), matches);
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
  const unique = completeFindings.filter((finding, index) => {
    const previous = completeFindings[index - 1];
    return (
      !previous ||
      previous.file !== finding.file ||
      previous.line !== finding.line ||
      previous.column !== finding.column ||
      previous.ruleId !== finding.ruleId
    );
  });
  return { scannedFiles: scanned.size, skippedFiles: 0, findings: unique };
}

export { checkPolyglot };
export type { PolyglotFinding, PolyglotScan };
