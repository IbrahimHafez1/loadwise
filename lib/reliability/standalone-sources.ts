// The swallowed-error rule only reads syntax, so it can also check the project's source files that no
// TypeScript program analyzed (plain JavaScript without `allowJs`, scripts outside `include`)
// without building a second program. The scan runs this once, after every program has run.
import fs from 'node:fs';
import path from 'node:path';
import * as bundled from 'typescript';
import { withSyntax } from '../performance/compiler.js';
import { relativeToProject, reviewedReason, reviewMarkers } from '../performance/review-context.js';
import { listFiles } from '../maintainability/inputs.js';
import { isVendoredMinified } from '../shared/execution-context.js';
import { checkSwallowedErrors } from './swallowed-errors.js';
import type { Finding } from '../shared/types.js';

const implementationFile = /(?<!\.d)\.[cm]?[jt]sx?$/i;

function normalizedPath(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

// Scripts and bundles can sit in folders with no tsconfig of their own, so the repository is the
// unit, not the config folder.
function repositoryRoot(configFolder: string): string {
  for (let folder = configFolder; ; folder = path.dirname(folder)) {
    if (fs.existsSync(path.join(folder, '.git'))) return folder;
    if (path.dirname(folder) === folder) return configFolder;
  }
}

function checkStandaloneFile(absolute: string): Finding[] {
  const sourceFile = bundled.createSourceFile(
    absolute,
    fs.readFileSync(absolute, 'utf8'),
    bundled.ScriptTarget.Latest,
    true,
  );
  const relative = relativeToProject(absolute).replaceAll('\\', '/');
  const findings = withSyntax(bundled, () => checkSwallowedErrors(sourceFile, relative));
  const hasReviewComments = reviewMarkers.some((marker) => sourceFile.text.includes(marker));
  return findings.map((finding) => {
    const reason = hasReviewComments ? reviewedReason(sourceFile, (finding.line ?? 1) - 1, finding.ruleId) : undefined;
    return { ...finding, file: absolute, ...(reason && { contextualReason: reason }) };
  });
}

// `roots` are the folders to list; `isScanned` takes an absolute file name and says whether any
// program analyzed it. Findings carry their absolute file name.
function standaloneFindings(roots: Iterable<string>, isScanned: (file: string) => boolean): Finding[] {
  const checked = new Set<string>();
  const findings: Finding[] = [];
  for (const root of roots) {
    for (const relative of listFiles(root)) {
      const absolute = path.resolve(root, relative);
      const key = normalizedPath(absolute);
      if (!implementationFile.test(relative) || checked.has(key) || isScanned(absolute) || isVendoredMinified(absolute))
        continue;
      checked.add(key);
      findings.push(...checkStandaloneFile(absolute));
    }
  }
  return findings;
}

export { standaloneFindings, repositoryRoot };
