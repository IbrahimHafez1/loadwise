'use strict';

// `--fix`: shows each available site fix as a diff and applies the ones the user accepts.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { applyFix } = require('../editor/apply-fix.cjs');
const { diffLines, findingLabel } = require('./finding-text.cjs');

const fileAccess = {
  readFile: (file) => fs.readFileSync(path.resolve(file), 'utf8'),
  writeFile: (file, text) => {
    // A fix can create a file, such as a migration, in a folder that does not exist yet.
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(path.resolve(file), text);
  },
};

function printFix(finding, index, total) {
  // Live-database findings name a table instead of a source position.
  const site = finding.file ? `${finding.file}:${finding.line}:${finding.column}` : finding.target;
  console.log(`\n[${index}/${total}] ${site} ${findingLabel(finding)}`);
  console.log('  ' + finding.message);
  for (const change of finding.fix.changes) {
    if (change.create) {
      console.log(`  ${change.file} (new file)`);
      for (const line of change.after.split('\n')) console.log('    + ' + line);
      continue;
    }
    console.log(`  ${change.file}:${change.line}`);
    for (const line of diffLines(change.before, change.after)) console.log(line);
  }
  if (finding.fix.note) console.log('  Note: ' + finding.fix.note);
}

async function askChoice(prompt) {
  const reader = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await reader.question(prompt)).trim().toLowerCase();
      if (['y', 'n', 'a', 'q'].includes(answer)) return answer;
      if (answer === '') return 'n';
    }
  } finally {
    reader.close();
  }
}

// Applies the finding's fix and returns why it could not be applied, or undefined once it is.
function chosenFixFailure(finding) {
  if (!finding) return 'unknown id';
  if (!finding.fix) return 'no automatic fix; this finding needs a manual change';
  return applyFix(finding.fix, fileAccess).error;
}

// `--fix --only`: applies exactly the named fixes without asking and reports each id that could not be applied.
function applyChosenFixes(findings, ids, { json = false } = {}) {
  const findingsById = new Map(findings.map((finding) => [finding.id, finding]));
  const chosen = ids.map((id) => findingsById.get(id)).filter(Boolean);
  require('./site-fix.cjs').attachSiteFixes(chosen);
  const applied = [];
  const failed = [];
  for (const [index, id] of ids.entries()) {
    const finding = findingsById.get(id);
    const reason = chosenFixFailure(finding);
    if (!json && finding?.fix) printFix(finding, index + 1, ids.length);
    if (reason) {
      failed.push({ id, reason });
      if (!json) console.log(`  ${id}: not applied, ${reason}.`);
    } else {
      applied.push(id);
      if (!json) console.log('  Applied.');
    }
  }
  if (json) console.log(JSON.stringify({ applied, failed }, null, 2));
  else {
    console.log(`\nApplied ${applied.length} of ${ids.length} chosen fix(es).`);
    if (applied.length) console.log('Review the changes and run your tests; rerun the check to confirm.');
  }
  return failed.length ? 2 : 0;
}

async function applyFixes(findings, { all = false } = {}) {
  const { attachSiteFixes } = require('./site-fix.cjs');
  attachSiteFixes(findings);
  const fixable = findings.filter((finding) => finding.fix);
  if (!all && !process.stdin.isTTY)
    throw new Error('--fix asks before each change; use --fix --yes without a terminal.');
  let applyRest = all;
  const applied = [];
  const failed = [];
  for (const [index, finding] of fixable.entries()) {
    printFix(finding, index + 1, fixable.length);
    if (!applyRest) {
      const choice = await askChoice('  Apply this fix? [y]es / [n]o / [a]ll remaining / [q]uit: ');
      if (choice === 'q') break;
      if (choice === 'n') continue;
      if (choice === 'a') applyRest = true;
    }
    const result = applyFix(finding.fix, fileAccess);
    if (result.error) {
      failed.push(finding);
      console.log('  Skipped: ' + result.error + '.');
    } else {
      applied.push(finding);
      console.log('  Applied.');
    }
  }
  const manual = findings.length - fixable.length;
  console.log(
    `\nApplied ${applied.length} of ${fixable.length} automatic fix(es)` +
      (failed.length ? `, ${failed.length} could not be applied` : '') +
      (manual ? `; ${manual} finding(s) need a manual change.` : '.'),
  );
  if (applied.length) console.log('Review the changes and run your tests; rerun the check to confirm.');
  return 0;
}

module.exports = { applyFixes, applyChosenFixes };
