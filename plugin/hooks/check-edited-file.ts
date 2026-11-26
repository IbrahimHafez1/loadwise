// PostToolUse hook: runs the project's local loadwise on the file Claude just edited.
// It must never break a session, so every failure path ends in a silent exit 0.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Finding } from '../../lib/shared/types.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

type CheckerCommand = 'perf' | 'maint' | 'sec';

interface LocalBinary {
  projectRoot: string;
  binary: string;
}

interface Launcher {
  command: string;
  args: string[];
}

/** What a checker prints with --json; only the findings matter here. */
interface HookReport {
  findings?: unknown;
}

/** The PostToolUse payload Claude Code sends on stdin. */
interface HookInput {
  cwd?: string;
  tool_input?: { file_path?: unknown };
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function findLocalBinary(startDirectory: string, stopRoot: string): LocalBinary | null {
  let directory = path.resolve(startDirectory);
  const boundary = path.resolve(stopRoot);
  for (;;) {
    const rel = path.relative(boundary, directory);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
    const entry = path.join(directory, 'node_modules', 'loadwise', 'bin', 'loadwise.js');
    if (fs.existsSync(entry)) return { projectRoot: directory, binary: entry };
    const candidate = path.join(directory, 'node_modules', '.bin', 'loadwise');
    if (fs.existsSync(candidate)) return { projectRoot: directory, binary: candidate };
    if (directory === boundary) return null;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function launcherFor(binary: string, args: string[]): Launcher {
  if (binary.endsWith('.js') || binary.endsWith('.cjs')) return { command: process.execPath, args: [binary, ...args] };
  const firstLine = fs.readFileSync(binary, 'utf8').split('\n', 1)[0];
  if (firstLine.startsWith('#!') && firstLine.includes('node')) {
    return { command: process.execPath, args: [binary, ...args] };
  }
  return { command: binary, args };
}

function runLoadwise(binary: string, args: string[], cwd: string, deadline: number): HookReport | null {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  const launcher = launcherFor(binary, args);
  const result = spawnSync(launcher.command, launcher.args, {
    cwd,
    encoding: 'utf8',
    timeout: remaining,
    windowsHide: true,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error || result.signal) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function findingsFor(report: HookReport | null, relativeFile: string, checkerCommand: CheckerCommand): Finding[] {
  const findings: Finding[] = report && Array.isArray(report.findings) ? report.findings : [];
  return findings
    .filter((finding) => path.normalize(finding.file ?? '') === relativeFile)
    .map((finding) => ({ ...finding, checkerCommand }));
}

function formatFeedback(projectRoot: string, relativeFile: string, findings: Finding[]): string {
  const sourceArgument = "'./" + relativeFile.split(path.sep).join('/').replaceAll("'", "'\\''") + "'";
  const lines = findings.map((finding) => {
    const target = finding.checkerCommand === 'maint' ? '.' : sourceArgument;
    const action = finding.fixable
      ? ` ${finding.fix?.requiresReview ? 'Review-marked fix' : 'Fix'} from ${projectRoot}: npx loadwise ${finding.checkerCommand} ${target} --fix --only ${finding.id}`
      : ' Manual finding. On an authorized fix request, inspect the callers, implement a justified edit here and run the relevant tests.';
    return `- #${finding.id} ${finding.ruleId} at ${relativeFile}:${finding.line}: ${finding.message}${action}`;
  });
  return `loadwise found ${findings.length} issue(s) in ${relativeFile}. Check each finding against the actual code, callers and tests. Apply or adapt a justified change within the user's request. Keep intentional behavior and explain why.\n${lines.join('\n')}`;
}

function main(): void {
  const input: HookInput | null = JSON.parse(readStdin());
  const filePath = input?.tool_input?.file_path;
  if (typeof filePath !== 'string' || !SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return;

  const workspaceRoot = path.resolve(input?.cwd ?? process.cwd());
  const absoluteFile = path.resolve(workspaceRoot, filePath);
  if (!fs.existsSync(absoluteFile)) return;
  const local = findLocalBinary(path.dirname(absoluteFile), workspaceRoot);
  if (!local) return;
  const relativeFile = path.relative(local.projectRoot, absoluteFile);
  if (
    relativeFile === '..' ||
    relativeFile.startsWith('..' + path.sep) ||
    relativeFile.split(path.sep).includes('node_modules')
  )
    return;

  const safeRelativeFile = relativeFile.startsWith('-') ? `./${relativeFile}` : relativeFile;
  const parsedTimeout = Number(process.env.LOADWISE_HOOK_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const perfReport = runLoadwise(local.binary, ['perf', safeRelativeFile, '--json'], local.projectRoot, deadline);
  const secReport = runLoadwise(local.binary, ['sec', safeRelativeFile, '--json'], local.projectRoot, deadline);
  // maint has no explicit-file mode, so scan the uncommitted changes and keep this file's findings.
  const maintReport = runLoadwise(
    local.binary,
    ['maint', '--changed-since', 'HEAD', '--json'],
    local.projectRoot,
    deadline,
  );
  const findings = [
    ...findingsFor(perfReport, relativeFile, 'perf'),
    ...findingsFor(maintReport, relativeFile, 'maint'),
    ...findingsFor(secReport, relativeFile, 'sec'),
  ];
  if (findings.length === 0) return;

  process.stdout.write(
    JSON.stringify({ decision: 'block', reason: formatFeedback(local.projectRoot, relativeFile, findings) }),
  );
}

try {
  main();
} catch {
  // Swallowed on purpose: a checker problem must not interrupt the session.
}
process.exit(0);
