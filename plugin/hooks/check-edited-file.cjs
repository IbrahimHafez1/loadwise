'use strict';
// PostToolUse hook: runs the project's local loadwise on the file Claude just edited.
// It must never break a session, so every failure path ends in a silent exit 0.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function findLocalBinary(startDirectory) {
  let directory = startDirectory;
  for (;;) {
    const entry = path.join(directory, 'node_modules', '@loadwise', 'cli', 'bin', 'loadwise.cjs');
    if (fs.existsSync(entry)) return { projectRoot: directory, binary: entry };
    const candidate = path.join(directory, 'node_modules', '.bin', 'loadwise');
    if (fs.existsSync(candidate)) return { projectRoot: directory, binary: candidate };
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function launcherFor(binary, args) {
  if (binary.endsWith('.cjs')) return { command: process.execPath, args: [binary, ...args] };
  const firstLine = fs.readFileSync(binary, 'utf8').split('\n', 1)[0];
  if (firstLine.startsWith('#!') && firstLine.includes('node')) {
    return { command: process.execPath, args: [binary, ...args] };
  }
  return { command: binary, args };
}

function runLoadwise(binary, args, cwd, deadline) {
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

function findingsFor(report, relativeFile, checkerCommand) {
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  return findings
    .filter((finding) => path.normalize(finding.file ?? '') === relativeFile)
    .map((finding) => ({ ...finding, checkerCommand }));
}

function formatFeedback(projectRoot, relativeFile, findings) {
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

function main() {
  const input = JSON.parse(readStdin());
  const filePath = input?.tool_input?.file_path;
  if (typeof filePath !== 'string' || !SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return;

  const absoluteFile = path.resolve(input.cwd ?? process.cwd(), filePath);
  if (!fs.existsSync(absoluteFile)) return;
  const local = findLocalBinary(path.dirname(absoluteFile));
  if (!local) return;
  const relativeFile = path.relative(local.projectRoot, absoluteFile);
  if (relativeFile.startsWith('..') || relativeFile.split(path.sep).includes('node_modules')) return;

  const timeoutMs = Number(process.env.LOADWISE_HOOK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const perfReport = runLoadwise(local.binary, ['perf', relativeFile, '--json'], local.projectRoot, deadline);
  const secReport = runLoadwise(local.binary, ['sec', relativeFile, '--json'], local.projectRoot, deadline);
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
