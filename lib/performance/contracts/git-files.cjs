'use strict';

// What changed since the comparison base, and the base's version of a file. Read-only git, no network.
const { git, mergeBaseSince } = require('../migrations/enforce.cjs');

function splitNul(output) {
  return output.split('\0').filter(Boolean);
}

// Changed paths under `cwd`, relative to it with forward slashes. Renames count as a removal plus an addition.
function changedSince(ref, cwd) {
  const { base } = mergeBaseSince(ref, cwd);
  const entries = splitNul(
    git(['diff', '--name-status', '-z', '--no-renames', '--relative', '--end-of-options', base, '--', '.'], cwd),
  );
  const changed = new Set();
  for (let index = 0; index + 1 < entries.length; index += 2) {
    if (entries[index] !== 'D') changed.add(entries[index + 1]);
  }
  for (const file of splitNul(git(['ls-files', '--others', '--exclude-standard', '-z'], cwd))) changed.add(file);
  return { base, changed };
}

// Every tracked or untracked, not ignored, file under `cwd`.
function listProjectFiles(cwd) {
  return splitNul(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd));
}

// The file's text at the base commit, or null when it did not exist there.
function readAtBase(base, file, cwd) {
  try {
    return git(['show', `${base}:./${file}`], cwd);
  } catch {
    return null;
  }
}

function insideNodeModules(file) {
  return file.split('/').includes('node_modules');
}

module.exports = { changedSince, insideNodeModules, listProjectFiles, readAtBase };
