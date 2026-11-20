'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');

const config = path.resolve(__dirname, '../polyglot/sgconfig.yml');
const extensions = new Set(['.py', '.go', '.java', '.cs', '.rs']);

function nativeBinary() {
  let binary;
  try {
    binary = require('@ast-grep/cli/postinstall.js').resolveBinaryPath();
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
  if (!binary) throw new Error('Polyglot checks require the optional @ast-grep/cli native package for this platform. Install with npm install --include=optional.');
  return binary;
}

async function checkPolyglot(paths) {
  if (!paths.length) throw new Error('Pass at least one source file or directory to polyglot.');
  const inputs = new Set();
  const explicitFiles = new Set();
  for (const requested of new Set(paths)) {
    let input = path.resolve(requested);
    const stat = fs.statSync(input, { throwIfNoEntry: false });
    if (!stat) throw new Error('Polyglot input does not exist: ' + input);
    if (!stat.isDirectory() && !(stat.isFile() && extensions.has(path.extname(input).toLowerCase()))) {
      throw new Error('Expected a directory or a .py, .go, .java, .cs or .rs file: ' + input);
    }
    if (process.platform === 'win32') {
      // Preserve symlinks and distinct entries in case-sensitive directories.
      const actual = fs.realpathSync.native(input);
      if (actual.toLowerCase() === input.toLowerCase()) input = actual;
    }
    inputs.add(input);
    if (stat.isFile()) explicitFiles.add(input);
  }
  const child = spawn(nativeBinary(), ['scan', '--config', config, '--custom-languages', 'ignore',
    '--json=stream', '--inspect=entity', '--', ...inputs], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const findings = [];
  const scanned = new Set();
  let finished = false;
  let failure;
  async function readMatches() {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      const match = JSON.parse(line);
      const { line: row, column } = match.range.start;
      const file = path.relative(process.cwd(), match.file).split(path.sep).join('/');
      if (match.ruleId.startsWith('polyglot-parse-error-')) {
        failure ||= `${file}:${row + 1}:${column + 1}: ${match.message}`;
        continue;
      }
      findings.push({ file, line: row + 1, column: column + 1, ruleId: match.ruleId, message: match.message });
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
  findings.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line ||
    left.column - right.column || left.ruleId.localeCompare(right.ruleId));
  // Explicit files can overlap with a directory passed on the same command line.
  const unique = findings.filter((finding, index) => {
    const previous = findings[index - 1];
    return !previous || previous.file !== finding.file || previous.line !== finding.line ||
      previous.column !== finding.column || previous.ruleId !== finding.ruleId;
  });
  return { scannedFiles: scanned.size, skippedFiles: 0, findings: unique };
}

module.exports = { checkPolyglot };
