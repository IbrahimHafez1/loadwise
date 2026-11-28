// Whether JSX in a file renders `javascript:` URLs as written. React 19 replaces them in `href`,
// `xlinkHref`, `src`, `action` and `formAction` itself; React 18 and older only warn, and Preact
// never checks. The answer comes from the nearest package.json that declares react-dom, react or
// preact; when no version can be read the answer is no, so the rule stays silent rather than guess.
import { declaredRange, nearestManifestAnswer } from './package-manifest.js';
import type { Manifest } from './package-manifest.js';

const FIRST_SANITIZING_REACT_MAJOR = 19;
// `^18.2.0`, `~18`, `>=18`, `>18.1`, `<19`, `18.x`, `=18.3.1`: an operator and the major it names.
const COMPARATOR = /^(<=?|>=?|[=^~])?v?(\d+)(?:\.(?:\d+|[xX*])){0,2}(?:[-+][\w.-]*)?$/;
const UPPER_BOUND_OPERATORS = new Set(['<', '<=']);

// The lowest major one `||` alternative allows. Space-separated comparators all apply, so the
// highest lower bound wins: `>=18 >=19` allows no React 18. In `18 - 19` only the start bounds it.
function alternativeMinimumMajor(alternative: string): number | undefined {
  const [start] = alternative.trim().split(/\s+-\s+/);
  const comparators = start.replaceAll(/([<>=^~])\s+(?=v?\d)/g, '$1').split(/\s+/);
  let minimum = 0;
  for (const comparator of comparators) {
    const match = COMPARATOR.exec(comparator);
    if (!match) return undefined;
    const [, operator = '', major] = match;
    if (!UPPER_BOUND_OPERATORS.has(operator)) minimum = Math.max(minimum, Number(major));
  }
  return minimum;
}

// The lowest major any alternative allows; undefined for tags, `*`, workspace or catalog links.
function minimumMajor(range: string): number | undefined {
  const majors = range.split('||').map(alternativeMinimumMajor);
  if (majors.some((major) => major === undefined)) return undefined;
  return Math.min(...majors.map(Number));
}

// undefined when this manifest declares none of the renderers.
function manifestAnswer(manifest: Manifest): boolean | undefined {
  const reactRange = declaredRange(manifest, 'react-dom') ?? declaredRange(manifest, 'react');
  if (reactRange !== undefined) {
    const major = minimumMajor(reactRange);
    return major !== undefined && major < FIRST_SANITIZING_REACT_MAJOR;
  }
  return declaredRange(manifest, 'preact') !== undefined ? true : undefined;
}

function rendersJavaScriptUrls(fileName: string): boolean {
  return nearestManifestAnswer(fileName, manifestAnswer);
}

export { rendersJavaScriptUrls };
