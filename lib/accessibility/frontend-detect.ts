// Whether a project has anything the accessibility checker reads. A backend-only repository skips it, so the default
// checker set costs nothing there.
import fs from 'node:fs';
import path from 'node:path';
import { listFiles } from '../maintainability/inputs.js';
import { isRecord } from '../shared/is-record.js';
import { discoverWorkspaces, selectWorkspaces } from '../shared/workspaces.js';

const frontendFilePattern = /\.(?:[jt]sx|html?|vue|svelte)$/i;
const frontendPackages: ReadonlySet<string> = new Set([
  'react',
  'react-dom',
  'preact',
  'vue',
  'nuxt',
  'svelte',
  '@sveltejs/kit',
  '@angular/core',
  'solid-js',
  'next',
  'astro',
  '@remix-run/react',
  'lit',
]);
const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function dependsOnFrontendPackage(manifestFile: string): boolean {
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch {
    return false;
  }
  if (!isRecord(manifest)) return false;
  return dependencyFields.some((field) => {
    const dependencies = manifest[field];
    return isRecord(dependencies) && Object.keys(dependencies).some((name) => frontendPackages.has(name));
  });
}

// Generated reports and build output hold HTML that nobody edits: coverage and test reports, rendered docs, bundles.
// Unlike the shared build-output rule, these names are excluded at any depth: no source folder is called that.
const generatedFolders: ReadonlySet<string> = new Set([
  'coverage',
  'htmlcov',
  '_build',
  'storybook-static',
  'playwright-report',
  'test-results',
  '.svelte-kit',
]);
// These also name source folders (`apps/site`, `src/out`), so they count only at the root, where mkdocs and Next export
// write. `dist` and `build` are left to listFiles, which skips them at the root and beside a manifest.
const rootGeneratedFolders: ReadonlySet<string> = new Set(['site', 'out']);

/** True for a path (relative, with `/` separators) inside a generated or report folder. */
function isGeneratedPath(relativePath: string): boolean {
  const segments = relativePath.split('/');
  const folders = segments.slice(0, -1);
  if (rootGeneratedFolders.has(folders[0] ?? '')) return true;
  return folders.some((segment) => generatedFolders.has(segment));
}

const listingByRoot = new Map<string, readonly string[]>();

/** The files under a folder, relative to it, walked once per process: detection and the markup scan share the listing. */
function listFrontendCandidateFiles(root: string): readonly string[] {
  const resolved = path.resolve(root);
  const known = listingByRoot.get(resolved);
  if (known) return known;
  const files = listFiles(resolved, [], isGeneratedPath);
  listingByRoot.set(resolved, files);
  return files;
}

const frontendByDirectory = new Map<string, boolean>();

/** True when the folder, or any workspace package under it, has JSX, HTML, Vue or Svelte files or a frontend dependency. */
function hasFrontendSources(directory: string): boolean {
  const resolved = path.resolve(directory);
  const known = frontendByDirectory.get(resolved);
  if (known !== undefined) return known;
  const found = listFrontendCandidateFiles(resolved).some(
    (file) =>
      frontendFilePattern.test(file) ||
      (path.posix.basename(file) === 'package.json' && dependsOnFrontendPackage(path.join(resolved, file))),
  );
  frontendByDirectory.set(resolved, found);
  return found;
}

/** Like `hasFrontendSources`, but only the workspace packages the selectors name when there are any. */
function hasFrontendSourcesInWorkspaces(directory: string, selectors: readonly string[]): boolean {
  if (!selectors.length) return hasFrontendSources(directory);
  try {
    const { packages, withoutConfig } = discoverWorkspaces(directory);
    const chosen = selectWorkspaces([...packages, ...withoutConfig], path.resolve(directory), selectors);
    return chosen.some((workspace) => hasFrontendSources(workspace.directory));
  } catch {
    // An unmatched selector is reported by the checker itself.
    return hasFrontendSources(directory);
  }
}

export { hasFrontendSources, hasFrontendSourcesInWorkspaces, listFrontendCandidateFiles };
