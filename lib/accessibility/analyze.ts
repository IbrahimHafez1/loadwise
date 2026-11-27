// The accessibility analyzer of the shared source pass: JSX and inline Angular templates in program files. Markup files
// outside the program (.html, .vue, .svelte) are read by template-file.ts.
import type { SourceFile } from 'typescript';
import { isVendoredMinified } from '../shared/execution-context.js';
import { relativeToProject, reviewedReason, reviewMarkers } from '../performance/review-context.js';
import type { Finding, ProgramAdapter } from '../shared/types.js';
import { jsxDocument } from './jsx-elements.js';
import { inlineAngularTemplates } from './angular-inline.js';
import { checkMarkup } from './rules.js';

const angularDecorator = '@Component';

function analyzeFile(_program: ProgramAdapter, sourceFile: SourceFile): Finding[] {
  if (sourceFile.isDeclarationFile || isVendoredMinified(sourceFile.fileName)) return [];
  const hasJsx = /\.[jt]sx$/i.test(sourceFile.fileName);
  const hasAngularComponent = sourceFile.text.includes(angularDecorator);
  if (!hasJsx && !hasAngularComponent) return [];
  const file = relativeToProject(sourceFile.fileName).split('\\').join('/');
  const documents = [
    ...(hasJsx ? [jsxDocument(sourceFile, file)] : []),
    ...(hasAngularComponent ? inlineAngularTemplates(sourceFile, file) : []),
  ];
  const findings = documents.flatMap((document) => checkMarkup(document));
  const hasReviewComments = reviewMarkers.some((marker) => sourceFile.text.includes(marker));
  return findings.map((finding) => {
    const reason = hasReviewComments ? reviewedReason(sourceFile, (finding.line ?? 1) - 1, finding.ruleId) : undefined;
    return { ...finding, file: sourceFile.fileName, ...(reason && { contextualReason: reason }) };
  });
}

export { analyzeFile };
