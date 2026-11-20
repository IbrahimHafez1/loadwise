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
    const candidate = path.join(directory, 'node_modules', '.bin', 'loadwise');
    if (fs.existsSync(candidate)) return { projectRoot: directory, binary: candidate };
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function launcherFor(binary, args) {
  const firstLine = fs.readFileSync(binary, 'utf8').split('\n', 1)[0];
  if (firstLine.startsWith('#!') && firstLine.includes('node')) {
    return { command: process.execPath, args: [binary, ...args], shell: false };
  }
  // npm's Windows shim for a package bin is a .cmd file next to the sh script.
  if (process.platform === 'win32') return { command: `${binary}.cmd`, args, shell: true };
  return { command: binary, args, shell: false };
}

function runLoadwise(binary, args, cwd, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  const launcher = launcherFor(binary, args);
  const result = spawnSync(launcher.command, launcher.args, {
    cwd,
    encoding: 'utf8',
    timeout: remaining,
    shell: launcher.shell,
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

function formatFeedback(relativeFile, findings) {
  const lines = findings.map((finding) => {
    const fixCommand = finding.fixable ? ` Fix: loadwise ${finding.checkerCommand} --fix --only ${finding.id}` : '';
    return `- #${finding.id} ${finding.ruleId} at ${relativeFile}:${finding.line}: ${finding.message}${fixCommand}`;
  });
  return `loadwise found ${findings.length} issue(s) in ${relativeFile}. Review each one; apply a fix only when it is correct for this code.\n${lines.join('\n')}`;
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
  ];
  if (findings.length === 0) return;

  process.stdout.write(JSON.stringify({ decision: 'block', reason: formatFeedback(relativeFile, findings) }));
}

try {
  main();
} catch {
  // Swallowed on purpose: a checker problem must not interrupt the session.
}
process.exit(0);
