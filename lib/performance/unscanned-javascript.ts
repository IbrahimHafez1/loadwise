// A tsconfig without `allowJs` leaves the project's JavaScript out of its program, while the
// maintainability check still reads it. A config the scan found itself has those files checked in a
// program of their own, so a missing `allowJs` never hides code from the performance and security
// checks; a config named on the command line is scanned exactly, and a note names what it leaves out.
import path from 'node:path';
import ts from 'typescript';
import { listFiles } from '../maintainability/inputs.js';
import { isVendoredMinified } from '../shared/execution-context.js';
import { isWithin } from '../shared/workspaces.js';

// A folder scanned with configs that have `allowJs` off, and whether the JavaScript they leave out is checked.
interface LeftOutScope {
  configs: string[];
  checksLeftOut: boolean;
}

const javaScript = /\.[cm]?jsx?$/i;
// Tool configs such as eslint.config.js or .prettierrc.cjs are rarely in a tsconfig and hold no
// application code.
const toolConfig = /(?:^|\/)(?:[^/]*\.config|\.[^/]*rc)\.[cm]?js$/i;
const shownExamples = 3;
const notedScopes = new Set<string>();
const canonical = (filename: string): string => {
  const resolved = path.resolve(filename);
  return ts.sys.useCaseSensitiveFileNames ? resolved : resolved.toLowerCase();
};

// A config's `include` usually names only its TypeScript, so only its `exclude` marks JavaScript its author left
// out on purpose. Listing every file under the config's folder through a config that extends it applies that
// `exclude`, inherited ones included.
function excludedBy(config: string): (filename: string) => boolean {
  const folder = path.dirname(config);
  const everything = ts.parseJsonConfigFileContent(
    { extends: './' + path.basename(config), files: [], include: ['**/*'], compilerOptions: { allowJs: true } },
    ts.sys,
    folder,
    undefined,
    path.join(folder, 'loadwise-left-out.json'),
  );
  const kept = new Set(everything.fileNames.map(canonical));
  return (filename) => isWithin(folder, filename) && !kept.has(canonical(filename));
}

// `isScanned` takes an absolute file name; `onlyFiles` limits the scan to changed or not ignored files.
// Returns the absolute names to check, and a note to print once they are checked.
function unscannedJavaScript(
  scopes: ReadonlyMap<string, LeftOutScope>,
  isScanned: (filename: string) => boolean,
  onlyFiles?: (filename: string) => boolean,
): { files: string[]; note: () => void } {
  const toCheck = new Set<string>();
  const notes: (() => void)[] = [];
  for (const [scope, { configs, checksLeftOut }] of scopes) {
    const exclusions = configs.map(excludedBy);
    const leftOut = listFiles(scope)
      .filter((file) => javaScript.test(file) && !toolConfig.test(file))
      .map((file) => path.resolve(scope, file))
      .filter(
        (filename) =>
          !isScanned(filename) &&
          !isVendoredMinified(filename) &&
          (!onlyFiles || onlyFiles(filename)) &&
          !exclusions.some((isExcluded) => isExcluded(filename)),
      );
    if (checksLeftOut) leftOut.forEach((filename) => toCheck.add(filename));
    notes.push(() => noteLeftOutJavaScript(scope, leftOut, checksLeftOut));
  }
  return { files: [...toCheck], note: () => notes.forEach((note) => note()) };
}

function noteLeftOutJavaScript(scope: string, filenames: readonly string[], checked: boolean): void {
  // Watch mode scans repeatedly, so each note prints once per process.
  const key = `${scope}\0${checked}`;
  if (!filenames.length || notedScopes.has(key)) return;
  notedScopes.add(key);
  const relative = filenames.map((filename) => path.relative(scope, filename).split(path.sep).join('/'));
  const folder = path.relative(process.cwd(), scope).split(path.sep).join('/') || '.';
  const examples = relative.slice(0, shownExamples).join(', ') + (relative.length > shownExamples ? ', ...' : '');
  const files = `${filenames.length} JavaScript file(s) (${examples})`;
  console.error(
    checked
      ? `Note: the project config in ${folder} does not set "allowJs", so ${files} were checked with standalone ` +
          'settings (ES2022, NodeNext). Set "allowJs": true or add a jsconfig.json beside the tsconfig.json to ' +
          "check them with the project's settings."
      : `Note: the performance and security checks skip ${files} in ${folder} because the project config does not ` +
          'set "allowJs". Set "allowJs": true or add a jsconfig.json beside the tsconfig.json to check them.',
  );
}

export { unscannedJavaScript };
export type { LeftOutScope };
