// What changed since the comparison base, and the base's version of a file. Read-only git, no
// network.
import { git, mergeBaseSince } from '../migrations/enforce.js';

function splitNul(output: string) {
  return output.split('\0').filter(Boolean);
}

// Changed paths under `cwd`, relative to it with forward slashes. Renames count as a removal plus
// an addition.
function changedSince(ref: string, cwd: string) {
  const { base } = mergeBaseSince(ref, cwd);
  const entries = splitNul(
    git(['diff', '--name-status', '-z', '--no-renames', '--relative', '--end-of-options', base, '--', '.'], cwd),
  );
  const changed = new Set<string>();
  for (let index = 0; index + 1 < entries.length; index += 2) {
    if (entries[index] !== 'D') changed.add(entries[index + 1]);
  }
  for (const file of splitNul(git(['ls-files', '--others', '--exclude-standard', '-z'], cwd))) changed.add(file);
  return { base, changed };
}

// Every tracked or untracked, not ignored, file under `cwd`.
function listProjectFiles(cwd: string) {
  return splitNul(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd));
}

// The file's text at the base commit, or null when it did not exist there.
function readAtBase(base: string, file: string, cwd: string) {
  try {
    return git(['show', `${base}:./${file}`], cwd);
  } catch {
    return null;
  }
}

function insideNodeModules(file: string) {
  return file.split('/').includes('node_modules');
}

export { changedSince, insideNodeModules, listProjectFiles, readAtBase };
