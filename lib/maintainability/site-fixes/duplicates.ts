// duplicate-implementation: keeps one top-level function and makes every other copy call it.
// Applied only when each name the copies use resolves to the same binding, so the call runs exactly
// the code the copy ran.
import fs from 'node:fs';
import path from 'node:path';
import { lineEnd, newlineOf, ownsLines } from './helpers.js';
import { stripExtension, bindings, checkerFor, isolatedHelper } from './duplicate-bindings.js';
import {
  canonicalCandidate,
  exported,
  isArrowSite,
  isMethodSite,
  kebabCase,
  leadingDoc,
  moduleImports,
  quoteOf,
  relativeSpecifier,
  removal,
  rewriteCopy,
  siteAt,
  withInsertion,
} from './duplicate-edits.js';
import { shareConfigCallbacks, shareExportedArrows } from './duplicate-arrows.js';
import { shareClassMethods } from './duplicate-methods.js';
import type { TypeChecker } from 'typescript';
import type { FileTarget, Finding, FixResult, TextEdit } from '../../shared/types.js';
import type { ProjectSiteFixInput } from '../types/site-fix-loader.js';
import type { ModuleCreatingFix } from '../types/created-module.js';
import type { DuplicateSite } from '../types/duplicate-sites.js';

// Importing one decorated class module from the other can introduce a cycle or execute decorators
// earlier. A new, independent module is an alternative for identical private helpers whose only
// consumers call them.
const maximumSharedHelperLines = 30;

function shareSiblingHelper(sites: readonly DuplicateSite[], checker: TypeChecker): ModuleCreatingFix | undefined {
  if (!sites.every(canonicalCandidate)) return;
  const first = sites[0];
  const helper = first.fn.name.text;
  const implementation = first.fn.getText(first.sourceFile);
  const helperDoc = leadingDoc(first);
  if (
    !/^[a-z][A-Za-z0-9]*$/.test(helper) ||
    implementation.split('\n').length > maximumSharedHelperLines ||
    /@|eslint|prettier/.test(helperDoc)
  )
    return;
  const folder = path.dirname(first.file);
  const stem = kebabCase(helper);
  const file = path.posix.join(folder.replaceAll('\\', '/'), stem + '.ts');
  const targets: FileTarget[] = [];
  for (const site of sites) {
    const { fn, sourceFile } = site;
    if (
      path.dirname(site.file) !== folder ||
      !site.file.endsWith('.ts') ||
      fn.modifiers?.length ||
      fn.getText(sourceFile) !== implementation ||
      leadingDoc(site) !== helperDoc ||
      !isolatedHelper(site, checker)
    )
      return;
    if (!ownsLines(fn)) return;
    const relativeImports = moduleImports(sourceFile).filter((statement) =>
      statement.moduleSpecifier.text.startsWith('.'),
    );
    const lastRelative = relativeImports.at(-1);
    if (!lastRelative || relativeImports.some((statement) => /\.[cm]?tsx?$/.test(statement.moduleSpecifier.text)))
      return;
    const specifier = relativeSpecifier(site.file, file, sourceFile);
    const quote = quoteOf(sourceFile);
    // The new import joins the file's own relative imports, after the last of them.
    const importAt = lineEnd(sourceFile.text, lastRelative.end);
    const importText = newlineOf(sourceFile.text) + `import { ${helper} } from ${quote}${specifier}${quote};`;
    const edits = withInsertion([removal(fn, sourceFile)], { start: importAt, end: importAt, text: importText });
    if (!edits) return;
    targets.push({ file: site.file, edits });
  }
  // Refuse shadowing by other extensions or a directory of the same name, including on
  // case-insensitive systems.
  const neighbors = fs.readdirSync(path.dirname(first.sourceFile.fileName));
  if (neighbors.some((name) => name.toLowerCase() === stem || name.toLowerCase().startsWith(stem + '.'))) return;
  return {
    targets,
    createdModule: { file, text: helperDoc + 'export ' + implementation + newlineOf(first.sourceFile.text) },
    requiresReview: true,
    note: 'Moves identical module-private helpers into a new sibling module. Verify that this helper should evolve with both consumers and is included by your build.',
  };
}

function buildDuplicate({ finding, load }: ProjectSiteFixInput): FixResult | undefined {
  const related: readonly Finding[] = Array.isArray(finding.related) ? finding.related : [];
  const sites: DuplicateSite[] = [];
  for (const location of [finding, ...related]) {
    const site = siteAt(load, location);
    if (!site) return;
    sites.push(site);
  }
  if (sites.every(isArrowSite)) return shareExportedArrows(sites) ?? shareConfigCallbacks(sites, load);
  if (sites.every(isMethodSite)) return shareClassMethods(sites, checkerFor(sites), load.createdModules);
  const candidates = sites.filter(canonicalCandidate);
  const canonical = candidates.find((site) => exported(site.fn)) ?? candidates[0];
  if (!canonical) return;
  const checker = checkerFor(sites);
  const resolved = sites.map((site) => bindings(checker, site.fn));
  const canonicalBindings = resolved[sites.indexOf(canonical)];
  const ownFileKey = 'file:' + stripExtension(path.resolve(canonical.sourceFile.fileName)) + '#';
  const editsByFile = new Map<string, TextEdit[]>();
  const addEdits = (file: string, edits: TextEdit[]): void => {
    editsByFile.set(file, [...(editsByFile.get(file) ?? []), ...edits]);
  };
  if (!exported(canonical.fn))
    addEdits(canonical.file, [
      {
        start: canonical.fn.getStart(canonical.sourceFile),
        end: canonical.fn.getStart(canonical.sourceFile),
        text: 'export ',
      },
    ]);
  for (const [index, copy] of sites.entries()) {
    if (copy === canonical) continue;
    const sameNames = canonicalBindings.every((binding, position) => {
      const other = resolved[index][position];
      if (!binding || !other) return false;
      if (binding === other) return copy.file === canonical.file || !binding.startsWith('file:');
      // A copy elsewhere may import the canonical file's own top-level name.
      return binding.startsWith(ownFileKey) && other === 'import:' + binding.slice('file:'.length);
    });
    if (!sameNames || resolved[index].length !== canonicalBindings.length) return;
    const edits = rewriteCopy(copy, canonical);
    if (!edits) return shareSiblingHelper(sites, checker);
    addEdits(copy.file, edits);
  }
  const location = `${canonical.file}:${canonical.fn.getSourceFile().getLineAndCharacterOfPosition(canonical.fn.name.getStart(canonical.sourceFile)).line + 1}`;
  return {
    targets: [...editsByFile].map(([file, edits]) => ({ file, edits })),
    note: `Keeps ${location} as the one implementation; the other copies now call it.`,
  };
}

export default { 'duplicate-implementation': buildDuplicate };
