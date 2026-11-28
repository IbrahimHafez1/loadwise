import type { SavedExcerpt, FindingDiagnostic, SourceRewrite } from './types/comparison.js';
import type { SourceDocument } from './types/source-document.js';

const scriptLanguages = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact']);
const maximumSnippetLength = 200;
const maximumBindingDistance = 12;
const maximumAnalyzedLines = 17;
const maximumAnalyzedCharacters = 1500;
const identifier = '[$A-Z_a-z][$\\w]*';
const member = identifier + '(?:\\.' + identifier + ')?';
const fallbackValue = '(?:new )?' + identifier + '(?:\\(\\))?|null|true|false|[0-9]+';
const guardedAssignment = new RegExp('^if\\s*\\(!(' + member + ')\\)\\s+\\1\\s*=\\s*(' + fallbackValue + ');$');
const simpleGuard = new RegExp('^if\\s*\\((!?' + identifier + '(?:\\.' + identifier + ')*(?:\\(\\))?)\\)\\s*\\{$');

function lineAt(document: SourceDocument, index: number): string {
  return index >= 0 && index < document.lineCount ? document.lineAt(index).text.trim() : '';
}

// A property getter can change a mutable receiver before the original assignment evaluates it a
// second time.
function stableReceiver(document: SourceDocument, row: number, target: string): boolean {
  if (!target.includes('.') || target.startsWith('this.')) return true;
  const name = target.split('.')[0];
  for (let index = row - 1; index >= Math.max(0, row - maximumBindingDistance); index--) {
    const text = lineAt(document, index);
    const declaration = /^const\s+([$A-Z_a-z][$\w]*)\s*=/.exec(text);
    if (declaration?.[1] === name) return true;
    if (text && !text.startsWith('//') && !/^if\s*\([^{};]*\)\s*\{$|^[$\w.]+\s*=\s*[$\w.]+;$/.test(text)) break;
  }
  return false;
}

// Do not change which condition owns an else, even when the clause starts on the next line.
function endsBranch(document: SourceDocument, lastRow: number): boolean {
  if (lastRow + 1 === document.lineCount) return true;
  const next = lineAt(document, lastRow + 1);
  return /^(?:\}|(?:return|throw|continue|break|const|let|if|for|while)\b)/.test(next);
}

function mergeGuards(document: SourceDocument, row: number): SourceRewrite | undefined {
  const outer = simpleGuard.exec(lineAt(document, row - 1));
  const inner = simpleGuard.exec(lineAt(document, row));
  if (!outer || !inner) return;
  const body = lineAt(document, row + 1);
  if (
    !/^[^{}`]*;$/.test(body) ||
    body.length > maximumSnippetLength ||
    lineAt(document, row + 2) !== '}' ||
    lineAt(document, row + 3) !== '}' ||
    !endsBranch(document, row + 3)
  )
    return;
  const before = Array.from({ length: 5 }, (_, offset) => document.lineAt(row - 1 + offset).text);
  const indent = /^\s*/.exec(before[0])?.[0] ?? '';
  const step = (/^\s*/.exec(before[1])?.[0] ?? '').slice(indent.length);
  if (!before.every((line) => line.startsWith(indent))) return;
  const combined = `if (${outer[1]} && ${inner[1]}) {`;
  return {
    before: before.map((line) => line.slice(indent.length)).join('\n'),
    code: `${combined}\n${step || '  '}${body}\n}`,
    inline: `${outer[0]} ${inner[0]} … } } → ${combined} … }`,
    note: 'Both conditions must pass before this statement runs. The combined guard tests them in the same order.',
  };
}

// Source-backed replacements only. The caller can show a separate illustrative example for other
// shapes.
function controlFlowComparison(document: SourceDocument, diagnostic: FindingDiagnostic): SourceRewrite | undefined {
  if (
    diagnostic.source !== 'loadwise maint' ||
    diagnostic.code !== 'deep-control-flow' ||
    !scriptLanguages.has(document.languageId) ||
    document.isDirty
  )
    return;
  const position = diagnostic.range.start;
  const row = position.line;
  if (row < 0 || row >= document.lineCount) return;
  const raw = document.lineAt(row).text;
  const before = raw.trim();
  if (position.character !== raw.indexOf(before)) return;
  if (matchesSavedExcerpt(document, row, diagnostic.comparison)) return diagnostic.comparison;
  if (before.length > maximumSnippetLength || !before.startsWith('if')) return;
  const match = guardedAssignment.exec(before);
  let result: SourceRewrite | undefined;
  if (match && stableReceiver(document, row, match[1]) && endsBranch(document, row)) {
    const code = `${match[1]} ||= ${match[2]};`;
    result = {
      before,
      code,
      inline: before + ' → ' + code,
      note: 'Logical OR assignment preserves the falsy check and evaluates the right-hand side only when needed.',
    };
  } else result = mergeGuards(document, row);
  if (!result) return;
  if (result.inline !== undefined && result.inline.length > maximumSnippetLength) delete result.inline;
  return { ...result, language: document.languageId.startsWith('typescript') ? 'typescript' : 'javascript' };
}

function matchesSavedExcerpt(document: SourceDocument, row: number, comparison: unknown): comparison is SavedExcerpt {
  if (
    typeof comparison !== 'object' ||
    comparison === null ||
    !('line' in comparison) ||
    !('before' in comparison) ||
    !('code' in comparison) ||
    !('inline' in comparison) ||
    !('note' in comparison) ||
    typeof comparison.line !== 'number' ||
    !Number.isSafeInteger(comparison.line) ||
    comparison.line < 1 ||
    typeof comparison.before !== 'string' ||
    comparison.before.length > maximumAnalyzedCharacters ||
    typeof comparison.code !== 'string' ||
    typeof comparison.inline !== 'string' ||
    typeof comparison.note !== 'string'
  )
    return false;
  const first = comparison.line - 1;
  const lines = comparison.before.split('\n');
  if (
    lines.length > maximumAnalyzedLines ||
    row < first ||
    row >= first + lines.length ||
    first + lines.length > document.lineCount
  )
    return false;
  const indent = /^[ \t]*/.exec(document.lineAt(first).text)?.[0] ?? '';
  return lines.every((line, index) => {
    const actual = document.lineAt(first + index).text;
    return actual === indent + line || (!line && !actual);
  });
}

export { controlFlowComparison };
