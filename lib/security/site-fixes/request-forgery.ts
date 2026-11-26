// Rule id -> build({ finding, node, sourceFile, text, load }) => { edits, note } | undefined; see
// lib/performance/site-fix.js.
import { ts, ancestor, calleeCall, replaceNode, requireReview } from '../../performance/site-fixes/helpers.js';
import type { FixResult, SiteFixBuilder, SiteFixInput, TextEdit } from '../../shared/types.js';

function pathImportEdit(input: SiteFixInput): TextEdit | undefined {
  const { sourceFile, text } = input;
  if (!sourceFile || text === undefined || /\bpath\b/.test(text)) return;
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  if (imports.length) {
    const last = imports[imports.length - 1];
    return { start: last.end, end: last.end, text: "\nimport path from 'node:path';" };
  }
  return { start: 0, end: 0, text: "import path from 'node:path';\n" };
}

function uploadClientFilenameFix(input: SiteFixInput): FixResult | undefined {
  const { node, sourceFile } = input;
  if (!node || !sourceFile) return;
  const access = ancestor(node, ts.isPropertyAccessExpression);
  if (!access || (access.name.text !== 'originalname' && access.name.text !== 'originalFilename')) return;
  const importEdit = pathImportEdit(input);
  const edits: TextEdit[] = [replaceNode(access, `path.basename(${access.getText(sourceFile)})`)];
  if (importEdit) edits.push(importEdit);
  return {
    edits,
    note: 'Strips directory components with `path.basename(...)`; combine with an extension/allowlist check and a generated filename.',
  };
}

function openRedirectFix({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const call = calleeCall(node);
  if (!call || !call.arguments.length) return;
  const target =
    call.arguments.length >= 2 && ts.isNumericLiteral(call.arguments[0]) ? call.arguments[1] : call.arguments[0];
  if (!target || ts.isStringLiteralLike(target)) return;
  const expr = target.getText(sourceFile);
  return {
    edits: [replaceNode(target, `(${expr}.startsWith('/') && !${expr}.startsWith('//') ? ${expr} : '/')`)],
    note: 'Restricts the redirect to a relative path starting with `/` (not `//`), falling back to `/`.',
  };
}

function pathTraversalFix(input: SiteFixInput): FixResult | undefined {
  const { node, sourceFile } = input;
  if (!node || !sourceFile) return;
  const call = calleeCall(node);
  if (!call || !call.arguments.length) return;
  const arg = call.arguments[0];
  if (!ts.isCallExpression(arg) || !ts.isPropertyAccessExpression(arg.expression)) return;
  if (arg.expression.name.text !== 'join' && arg.expression.name.text !== 'resolve') return;
  const lastArg = arg.arguments.at(-1);
  if (!lastArg || ts.isStringLiteralLike(lastArg)) return;
  const importEdit = pathImportEdit(input);
  const edits: TextEdit[] = [replaceNode(lastArg, `path.basename(${lastArg.getText(sourceFile)})`)];
  if (importEdit) edits.push(importEdit);
  return {
    edits,
    note: 'Strips directory traversal segments with `path.basename(...)`; verify whether subdirectories should be allowed via a canonical `startsWith(base + path.sep)` check.',
  };
}

const builders: Record<string, SiteFixBuilder> = {
  'upload-client-filename': uploadClientFilenameFix,
  'open-redirect': requireReview(
    'Rejects external URLs in redirects; confirm cross-origin redirects are not intended.',
    openRedirectFix,
  ),
  'path-traversal': requireReview(
    'Flattens the final path segment with `path.basename()`; confirm nested relative paths are not required.',
    pathTraversalFix,
  ),
};

export default builders;
