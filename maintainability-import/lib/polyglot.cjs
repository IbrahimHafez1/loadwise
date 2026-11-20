'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const { byLanguage, nonJsLanguages, rulesFor } = require('../polyglot/rules.cjs');
const { createDuplicateIndex } = require('./polyglot-duplicates.cjs');

const config = path.resolve(__dirname, '../polyglot/sgconfig.yml');
// Leave room for Windows quoting, the executable path, and the environment-independent command prefix.
const maxCommandUnits = 28000;
const maxFilesPerBatch = 400;

function parserPath() {
  let binary;
  try {
    binary = require('@ast-grep/cli/postinstall.js').resolveBinaryPath();
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
  if (!binary)
    throw new Error(
      'Non-JavaScript checks require the optional @ast-grep/cli binary for this platform. Install with npm install --include=optional.',
    );
  return binary;
}

async function scanBatch(binary, args, root, files, language, findings, duplicates) {
  const parser = byLanguage.get(language).parser;
  const relative = (filename) => path.relative(root, path.resolve(root, filename)).split(path.sep).join('/');
  const expected = new Set(files);
  const scanned = new Set();
  let failure;
  let summary = false;
  const child = spawn(binary, [...args, ...files], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  async function matches() {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      const match = JSON.parse(line);
      const file = relative(match.file);
      const { line: row, column } = match.range.start;
      if (!expected.has(file)) throw new Error('Unexpected parser result for ' + file);
      if (match.ruleId === 'syntax-error')
        failure ||= file + ':' + (row + 1) + ':' + (column + 1) + ': ' + match.message;
      else if (match.ruleId === 'duplicate-body-candidate') duplicates.add(language, file, match);
      else findings.push({ file, line: row + 1, column: column + 1, ruleId: match.ruleId, message: match.message });
    }
  }
  async function status() {
    for await (const line of createInterface({ input: child.stderr, crlfDelay: Infinity })) {
      const event = /^sg: entity\|file\|(.+): (?:language=(\w+),appliedRuleCount=(\d+)|skipped=(\w+))$/.exec(line);
      if (event) {
        const file = relative(event[1]);
        if (
          expected.has(file) &&
          ((event[2]?.toLowerCase() === parser.toLowerCase() && Number(event[3]) > 0) || event[4] === 'emptyFile')
        )
          scanned.add(file);
        else failure ||= 'Could not verify ' + file + ' with the ' + parser + ' parser.';
      } else if (line.startsWith('sg: summary|file: scannedFileCount=')) summary = true;
      else if (line.trim() && !line.startsWith('sg: ')) failure ||= line.trim();
    }
  }
  try {
    const [[code, signal]] = await Promise.all([once(child, 'close'), matches(), status()]);
    if (failure || code !== 0) throw new Error(failure || 'Parser failed: ' + (signal || code));
    if (!summary) throw new Error('Parser omitted its scan summary.');
    for (const file of expected) if (!scanned.has(file)) throw new Error('No parser result for ' + file);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    throw error;
  }
}

async function analyzePolyglot({ root, files }) {
  const groups = new Map();
  for (const file of new Set(files)) {
    const language = nonJsLanguages[path.extname(file).toLowerCase()];
    if (!language) throw new Error('Unsupported non-JavaScript extension: ' + file);
    if (!groups.has(language)) groups.set(language, []);
    groups.get(language).push(file);
  }
  const findings = [];
  const languageCounts = {};
  if (!groups.size) return { findings, languageCounts };
  const binary = parserPath();
  const duplicates = createDuplicateIndex();
  for (const [language, inputs] of groups) {
    const args = [
      'scan',
      '--config',
      config,
      '--inline-rules',
      rulesFor(language),
      '--custom-languages',
      'ignore',
      '--json=stream',
      '--inspect=entity',
      '--',
    ];
    const used = [binary, ...args].reduce((size, argument) => size + argument.length * 2 + 3, 0);
    const budget = maxCommandUnits - used;
    let batch = [];
    let current = 0;
    for (const file of inputs) {
      const units = file.length * 2 + 3;
      if (units > budget) throw new Error('Input path exceeds the parser command size limit: ' + file);
      if (current + units > budget || batch.length === maxFilesPerBatch) {
        await scanBatch(binary, args, root, batch, language, findings, duplicates);
        batch = [];
        current = 0;
      }
      batch.push(file);
      current += units;
    }
    await scanBatch(binary, args, root, batch, language, findings, duplicates);
    languageCounts[language] = inputs.length;
  }
  for (const group of duplicates.findings()) findings.push(group);
  findings.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.ruleId.localeCompare(right.ruleId),
  );
  return { findings, languageCounts };
}

module.exports = { analyzePolyglot, nonJsLanguages };
