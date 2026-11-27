// A tsconfig without `allowJs` leaves the project's JavaScript out of the performance and security
// checks, while the maintainability check still reads it. The project inventory names those files,
// so they are never skipped silently.
import path from 'node:path';
import { listFiles } from '../maintainability/inputs.js';

const javaScript = /\.[cm]?jsx?$/i;
// Tool configs such as eslint.config.js or .prettierrc.cjs are rarely in a tsconfig and hold no
// application code.
const toolConfig = /(?:^|\/)(?:[^/]*\.config|\.[^/]*rc)\.[cm]?js$/i;
const shownExamples = 3;
const notedScopes = new Set<string>();

// `scopes` are the folders scanned with a config that has `allowJs` off; `isScanned` takes an
// absolute file name.
function noteUnscannedJavaScript(scopes: readonly string[], isScanned: (filename: string) => boolean): void {
  for (const scope of scopes) {
    if (notedScopes.has(scope)) continue;
    notedScopes.add(scope);
    const unscanned = listFiles(scope).filter(
      (file) => javaScript.test(file) && !toolConfig.test(file) && !isScanned(path.resolve(scope, file)),
    );
    if (!unscanned.length) continue;
    const folder = path.relative(process.cwd(), scope).split(path.sep).join('/') || '.';
    const examples = unscanned.slice(0, shownExamples).join(', ') + (unscanned.length > shownExamples ? ', ...' : '');
    console.error(
      `Note: the performance and security checks skip ${unscanned.length} JavaScript file(s) in ${folder} ` +
        `(${examples}) because the project config does not set "allowJs". ` +
        'Set "allowJs": true or add a jsconfig.json beside the tsconfig.json to check them.',
    );
  }
}

export { noteUnscannedJavaScript };
