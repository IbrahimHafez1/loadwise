// Whether JSX in a file renders `javascript:` URLs as written. React 19 replaces them in `href`,
// `src`, `action` and `formAction` itself; React 18 and older only warn, and Preact never checks.
// The answer comes from the nearest package.json that declares react-dom, react or preact; when no
// version can be read the answer is no, so the rule stays silent rather than guess.
import fs from 'node:fs';
import path from 'node:path';

const FIRST_SANITIZING_REACT_MAJOR = 19;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'];
// `^18.2.0`, `~18`, `>=18 <20`, `18.x`, `=18.3.1`: the major the range starts at.
const RANGE_START = /^\s*(?:[\^~]|>=?|=)?\s*v?(\d+)/;
const answerByDirectory = new Map<string, boolean>();

function readManifest(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? { ...parsed } : undefined;
  } catch {
    // A missing or malformed manifest says nothing about React; the search continues upward.
    return undefined;
  }
}

function declaredRange(manifest: Record<string, unknown>, packageName: string): string | undefined {
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (dependencies === null || typeof dependencies !== 'object') continue;
    const range: unknown = Object.entries(dependencies).find(([name]) => name === packageName)?.[1];
    if (typeof range === 'string') return range;
  }
}

// The lowest major any `||` alternative allows; undefined for tags, workspace or catalog links.
function minimumMajor(range: string): number | undefined {
  const majors = range.split('||').map((alternative) => RANGE_START.exec(alternative)?.[1]);
  if (majors.some((major) => major === undefined)) return undefined;
  return Math.min(...majors.map(Number));
}

// undefined when this manifest declares none of the renderers.
function manifestAnswer(manifest: Record<string, unknown>): boolean | undefined {
  const reactRange = declaredRange(manifest, 'react-dom') ?? declaredRange(manifest, 'react');
  if (reactRange !== undefined) {
    const major = minimumMajor(reactRange);
    return major !== undefined && major < FIRST_SANITIZING_REACT_MAJOR;
  }
  return declaredRange(manifest, 'preact') !== undefined ? true : undefined;
}

function answerFor(directory: string): boolean {
  const cached = answerByDirectory.get(directory);
  if (cached !== undefined) return cached;
  const manifest = readManifest(path.join(directory, 'package.json'));
  const parent = path.dirname(directory);
  const answer = (manifest && manifestAnswer(manifest)) ?? (parent === directory ? false : answerFor(parent));
  answerByDirectory.set(directory, answer);
  return answer;
}

function rendersJavaScriptUrls(fileName: string): boolean {
  return answerFor(path.dirname(path.resolve(fileName)));
}

export { rendersJavaScriptUrls };
