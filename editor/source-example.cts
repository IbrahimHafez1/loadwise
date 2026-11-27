import { perfSiteComparison } from './perf-site-comparison.cjs';
import type { FindingDiagnostic, SourceRewrite } from './types/comparison.cjs';
import type { SourceDocument } from './types/source-document.cjs';

const scriptLanguages = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact']);
// An omitted semicolon can continue the expression on the next line.
const membershipExpression =
  /^\s*(return\s+)?(!?)\s*([$A-Z_a-z][$\w]*)\.(every|some)\(\s*(\()?([$A-Z_a-z][$\w]*)(\))?\s*=>\s*([$A-Z_a-z][$\w]*(?:\.[$A-Z_a-z][$\w]*)?)\.includes\(\s*([$A-Z_a-z][$\w]*)\s*\)\s*\);\s*$/;

function sourceExampleFor(document: SourceDocument, diagnostic: FindingDiagnostic): SourceRewrite | undefined {
  if (diagnostic.source !== 'loadwise perf' || !scriptLanguages.has(document.languageId) || document.isDirty) return;

  const position = diagnostic.range.start;
  if (position.line < 0 || position.line >= document.lineCount) return;
  const line = document.lineAt(position.line).text;
  if (diagnostic.code !== 'array-repeated-membership') {
    const site = perfSiteComparison(document, line, diagnostic);
    return site && { ...site, language: document.languageId.startsWith('typescript') ? 'typescript' : 'javascript' };
  }
  if (diagnostic.message?.startsWith('This array was copied from a Set')) return;
  if (line.lastIndexOf('.includes(') + 1 !== position.character) return;
  const match = membershipExpression.exec(line);
  if (!match) return;
  const [, returns, negate, values, quantifier, open, parameter, close, lookup, argument] = match;
  const receiver = lookup.split('.')[0];
  const setName = lookup.split('.').at(-1) + 'Set';
  if (
    Boolean(open) !== Boolean(close) ||
    parameter !== argument ||
    parameter === receiver ||
    receiver === 'globalThis' ||
    values === 'globalThis' ||
    [values, parameter, receiver].includes(setName)
  )
    return;

  const result = {
    language: document.languageId.startsWith('typescript') ? 'typescript' : 'javascript',
    inline: `${lookup}.includes(${argument}) → ${setName}.has(${argument}) with a Set built before the loop`,
    note: 'Build the set here when the lookup array is stable and repeated searches justify its construction cost. Keep any surrounding guards.',
  };
  const build = `const ${setName} = new globalThis.Set(${lookup});`;
  const check = `${negate}${values}.${quantifier}((${parameter}) => ${setName}.has(${parameter}));`;
  const emptyResult = (quantifier === 'every') !== Boolean(negate);
  // A block preserves a preceding unbraced branch and keeps the new name local.
  if (returns) {
    const emptyGuard = receiver !== lookup ? `  if (${values}.length === 0) return ${emptyResult};\n` : '';
    return { ...result, code: `{\n${emptyGuard}  ${build}\n  return ${check}\n}` };
  }

  // In a short-circuiting declaration the lookup can be expensive or unavailable on the early path.
  if (position.line < 2) return;
  const declaration = document.lineAt(position.line - 2).text.trim();
  const name = /^const ([$A-Z_a-z][$\w]*)\s*=$/.exec(declaration)?.[1];
  const alternative = /^([$A-Z_a-z][$\w]*\.includes\(\s*[$A-Z_a-z][$\w]*\s*\))\s*\|\|$/.exec(
    document.lineAt(position.line - 1).text.trim(),
  )?.[1];
  if (
    !name ||
    !alternative?.startsWith(values + '.includes(') ||
    name === setName ||
    name === 'globalThis' ||
    emptyResult
  )
    return;
  return {
    ...result,
    before: `${declaration}\n  ${alternative} ||\n  ${line.trim()}`,
    code: `let ${name} = ${alternative};\nif (!${name} && ${values}.length > 0) {\n  ${build}\n  ${name} = ${check}\n}`,
  };
}

export { sourceExampleFor };
