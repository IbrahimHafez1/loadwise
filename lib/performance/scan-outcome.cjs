'use strict';

function noteEmptyIgnoredScan(result, values, scope) {
  // TypeScript rejects a project with no inputs, but one emptied by ignore globs scans nothing without complaint.
  if (scope || !values.settings.isIgnored || result.scannedFiles !== 0) return;
  console.error(
    `Note: every source file matches "ignore" in ${values.settings.filename}; no files were left to check.`,
  );
}

// A skipped file is coverage the report lacks, so it is listed once and the run can never look like a pass.
function recordSkippedFile(skippedFiles, { file, reason }, note) {
  if (skippedFiles.some((skipped) => skipped.file === file && skipped.reason === reason)) return;
  skippedFiles.push({ file, reason });
  console.error('Note: ' + note);
}

const invalidInputExitCode = 2;

function exitCodeWithSkips(result, code) {
  return result.skippedFiles?.length ? invalidInputExitCode : code;
}

function reportSourceResult({ result, usedFallback, values, project, baselineOptions, positionals, scope, report }) {
  const reportValues = {
    ...values,
    project,
    baselineOptions,
    fixCommand: require('../shared/source-report.cjs').fixAllCommand(
      'perf',
      project,
      positionals,
      usedFallback ? { ...values, engine: 'js' } : values,
    ),
  };
  return report(result, scope ? { ...reportValues, changedLines: scope.changedLines } : reportValues);
}

function editorAnalyzers() {
  return [...require('./projects.cjs').performanceAnalyzers, require('../security/cli.cjs').analyzer];
}

module.exports = { editorAnalyzers, exitCodeWithSkips, noteEmptyIgnoredScan, recordSkippedFile, reportSourceResult };
