import ts from 'typescript';
import type { SiteFixBuilder, SiteFixInput } from '../../shared/types.js';

function unusedExportFix({ node, sourceFile }: SiteFixInput) {
  if (!node || !sourceFile) return;
  const target = ts.findAncestor(
    node,
    (candidate) =>
      ts.canHaveModifiers(candidate) &&
      Boolean(ts.getModifiers(candidate)?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)),
  );
  if (!target || !ts.canHaveModifiers(target)) return;
  const exportMod = ts.getModifiers(target)?.find((mod) => mod.kind === ts.SyntaxKind.ExportKeyword);
  if (!exportMod) return;
  const start = exportMod.getStart(sourceFile);
  let end = exportMod.end;
  if (sourceFile.text[end] === ' ') end++;
  return {
    edits: [{ start, end, text: '' }],
    requiresReview: true,
    note: 'Removes the unused `export` modifier; verify no external package or dynamic import relies on it.',
  };
}

const builders: Record<string, SiteFixBuilder> = {
  'unused-export': unusedExportFix,
};

export default builders;
