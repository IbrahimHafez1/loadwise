'use strict';

// `--fix`: shows each available site fix as a diff and applies the ones the user accepts.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { applyFix } = require('./apply-fix.cjs');
const { diffLines } = require('./fix-text.cjs');

const byteOrderMark = '\uFEFF';

// Fix changes name project-relative files. A byte order mark is kept out of the matched text and written back.
function projectFiles(root) {
  const marked = new Set();
  return {
    readFile(file) {
      const text = fs.readFileSync(path.resolve(root, file), 'utf8');
      if (!text.startsWith(byteOrderMark)) return text;
      marked.add(file);
      return text.slice(1);
    },
    writeFile(file, text) {
      fs.writeFileSync(path.resolve(root, file), (marked.has(file) ? byteOrderMark : '') + text);
    },
  };
}

function printFix(finding, index, total) {
  console.log(`\n[${index}/${total}] ${finding.file}:${finding.line}:${finding.column} [${finding.ruleId}]`);
  console.log('  ' + finding.message);
  for (const change of finding.fix.changes) {
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

// Findings must already carry their site fixes. Several fixes can touch one function; a later fix whose lines an
// earlier one changed is skipped as stale and reappears, rebuilt, on the next run.
async function applyFixes(findings, root, { all = false } = {}) {
  if (!all && !process.stdin.isTTY)
    throw new Error('--fix asks before each change; use --fix --yes without a terminal.');
  const fixable = findings.filter((finding) => finding.fix);
  const files = projectFiles(root);
  let applyRest = all;
  let applied = 0;
  let failed = 0;
  for (const [index, finding] of fixable.entries()) {
    printFix(finding, index + 1, fixable.length);
    if (!applyRest) {
      const choice = await askChoice('  Apply this fix? [y]es / [n]o / [a]ll remaining / [q]uit: ');
      if (choice === 'q') break;
      if (choice === 'n') continue;
      if (choice === 'a') applyRest = true;
    }
    const result = applyFix(finding.fix, files);
    if (result.error) {
      failed++;
      console.log('  Skipped: ' + result.error + '.');
    } else {
      applied++;
      console.log('  Applied.');
    }
  }
  const manual = findings.length - fixable.length;
  console.log(
    `\nApplied ${applied} of ${fixable.length} automatic fix(es)` +
      (failed ? `, ${failed} could not be applied` : '') +
      (manual ? `; ${manual} finding(s) need a manual change.` : '.'),
  );
  if (applied) console.log('Review the changes and run your tests; rerun the check to confirm.');
  return 0;
}

module.exports = { applyFixes };
