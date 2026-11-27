// A tsconfig without `allowJs` leaves the project's JavaScript out of its program, while the
// maintainability check still reads it. A config the scan found itself has those files checked in a
// program of their own, so a missing `allowJs` never hides code from the performance and security
// checks; a config named on the command line is scanned exactly, and a note names what it leaves out.
import path from 'node:path';
import { listFiles } from '../maintainability/inputs.js';
import { isVendoredMinified } from '../shared/execution-context.js';

const javaScript = /\.[cm]?jsx?$/i;
// Tool configs such as eslint.config.js or .prettierrc.cjs are rarely in a tsconfig and hold no
// application code.
const toolConfig = /(?:^|\/)(?:[^/]*\.config|\.[^/]*rc)\.[cm]?js$/i;
const shownExamples = 3;
const notedScopes = new Set<string>();

// `scopes` maps each folder scanned with a config that has `allowJs` off to whether its left-out
// JavaScript is checked; `isScanned` takes an absolute file name. Returns the absolute names to check.
function unscannedJavaScript(scopes: ReadonlyMap<string, boolean>, isScanned: (filename: string) => boolean): string[] {
  const toCheck = new Set<string>();
  for (const [scope, checksLeftOut] of scopes) {
    const leftOut = listFiles(scope)
      .filter((file) => javaScript.test(file) && !toolConfig.test(file))
      .map((file) => path.resolve(scope, file))
      .filter((filename) => !isScanned(filename) && !isVendoredMinified(filename));
    if (checksLeftOut) leftOut.forEach((filename) => toCheck.add(filename));
    noteLeftOutJavaScript(scope, leftOut, checksLeftOut);
  }
  return [...toCheck];
}

function noteLeftOutJavaScript(scope: string, filenames: readonly string[], checked: boolean): void {
  if (!filenames.length || notedScopes.has(scope)) return;
  notedScopes.add(scope);
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
