// The nearest package.json that answers a question about a file's project, read fresh on every
// call. Callers ask only after a candidate finding, so the walk is rare, and nothing goes stale
// when the editor's long-lived process sees a manifest change.
import fs from 'node:fs';
import path from 'node:path';

type Manifest = Record<string, unknown>;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function readManifest(file: string): Manifest | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? { ...parsed } : undefined;
  } catch {
    // A missing or malformed manifest answers nothing; the search continues upward.
    return undefined;
  }
}

function declaredRange(manifest: Manifest, packageName: string): string | undefined {
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (dependencies === null || typeof dependencies !== 'object') continue;
    const range: unknown = Object.entries(dependencies).find(([name]) => name === packageName)?.[1];
    if (typeof range === 'string') return range;
  }
}

// The first manifest, from the file's directory upward, whose `answerOf` is defined; false when none.
function nearestManifestAnswer(fileName: string, answerOf: (manifest: Manifest) => boolean | undefined): boolean {
  let directory = path.dirname(path.resolve(fileName));
  for (;;) {
    const manifest = readManifest(path.join(directory, 'package.json'));
    const answer = manifest && answerOf(manifest);
    if (answer !== undefined) return answer;
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

// Only the file's own project counts: a nested Vite app under an Astro workspace root is not Astro.
function projectDeclares(fileName: string, packageName: string): boolean {
  return nearestManifestAnswer(fileName, (manifest) => declaredRange(manifest, packageName) !== undefined);
}

export { declaredRange, nearestManifestAnswer, projectDeclares };
export type { Manifest };
