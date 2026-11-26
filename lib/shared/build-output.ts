// Folder names that hold generated output, vendored dependencies or coverage, but only where a build puts them: at
// the scanned root or beside a project manifest. Elsewhere, such as `src/build/`, the name is the project's own source.
import fs from 'node:fs';
import path from 'node:path';

const buildOutputNames = new Set(['build', 'coverage', 'dist', 'target', 'vendor']);
const manifests = [
  'package.json',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'go.mod',
];

// `relative` is the folder's `/`-separated path from `root`.
function isBuildOutputFolder(root: string, relative: string) {
  if (!buildOutputNames.has(path.posix.basename(relative))) return false;
  const parent = path.posix.dirname(relative);
  return parent === '.' || manifests.some((manifest) => fs.existsSync(path.join(root, parent, manifest)));
}

export { isBuildOutputFolder };
