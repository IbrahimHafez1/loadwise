'use strict';

async function askChoice(prompt) {
  const readline = require('node:readline/promises');
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

function indentationWidth(line) {
  return /^[ \t]*/.exec(line)[0].length;
}

// Unchanged lines at either end print as context, so the reader sees exactly which lines change.
function diffLines(before, after) {
  const removed = before.split('\n');
  const added = after.split('\n');
  let prefix = 0;
  while (prefix < removed.length && prefix < added.length && removed[prefix] === added[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < removed.length - prefix &&
    suffix < added.length - prefix &&
    removed.at(-1 - suffix) === added.at(-1 - suffix)
  )
    suffix++;
  const rows = [
    ...removed.slice(0, prefix).map((line) => ['  ', line]),
    ...removed.slice(prefix, removed.length - suffix).map((line) => ['- ', line]),
    ...added.slice(prefix, added.length - suffix).map((line) => ['+ ', line]),
    ...removed.slice(removed.length - suffix).map((line) => ['  ', line]),
  ];
  const indentation = Math.min(...rows.filter(([, line]) => line.trim()).map(([, line]) => indentationWidth(line)));
  return rows.map(([marker, line]) => '    ' + marker + line.slice(indentation));
}

module.exports = { askChoice, diffLines };
