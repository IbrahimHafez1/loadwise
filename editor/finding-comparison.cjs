'use strict';

const { controlFlowComparison } = require('./control-flow-comparison.cjs');
const { sourceExampleFor } = require('./source-example.cjs');

const maxExcerptLength = 220;
const maxInlineLength = 150;
const controls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function cleanLine(text) {
  return typeof text === 'string' ? text.replace(controls, ' ').trim() : '';
}

function shorten(text) {
  return text.length <= maxInlineLength ? text : text.slice(0, maxInlineLength - 1).trimEnd() + '…';
}

function flaggedLine(text, column) {
  if (text.trim().length <= maxExcerptLength) return text.trim();
  // Center long lines on the reported token, including when a generated file occupies a single line.
  const start = Math.max(0, Math.min(column - Math.floor(maxExcerptLength / 2), text.length - maxExcerptLength));
  const end = start + maxExcerptLength;
  return (start ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

function getFindingComparison(document, diagnostic, example) {
  const position = diagnostic.range.start;
  if (document.isDirty || position.line < 0 || position.line >= document.lineCount) return;
  const text = document.lineAt(position.line).text;
  if (position.character < 0 || position.character > text.length || !text.trim()) return;
  const rewrite = controlFlowComparison(document, diagnostic) ?? sourceExampleFor(document, diagnostic);
  if (rewrite) {
    return {
      kind: 'source',
      before: rewrite.before ?? text.trim(),
      after: rewrite.code,
      language: rewrite.language,
      note: rewrite.note,
      inline: rewrite.inline,
    };
  }
  const suggestion = cleanLine(diagnostic.suggestion || example?.review);
  if (suggestion) return { kind: 'review', before: flaggedLine(text, position.character), inline: suggestion };
  if (!example) return;
  return {
    kind: 'illustration',
    before: flaggedLine(text, position.character),
    after: example.code,
    language: example.language,
    note: example.note,
    message: diagnostic.message,
    inline: example.inline,
  };
}

function inlineComparison(comparison) {
  if (!comparison) return;
  if (comparison.kind === 'review') return shorten('Review: ' + comparison.inline);
  if (comparison.inline) return shorten(cleanLine(comparison.inline));
  if (!/[\r\n\u2028\u2029]/.test(comparison.after)) {
    if (comparison.kind === 'source') {
      const pair = comparison.before + ' → ' + comparison.after;
      if (pair.length <= maxInlineLength && !/[\r\n]/.test(pair)) return cleanLine(pair);
    }
    return shorten((comparison.kind === 'source' ? 'Use: ' : 'Example: ') + cleanLine(comparison.after));
  }
  // Multiline code can contain comments, templates or indentation-sensitive blocks. Keep it intact in the hover.
  const action = comparison.message?.match(
    /(?:^|[.!?] )((?:Use|Consider|Compile|Reuse|Build|Move|Batch|Fetch|Bind|Pass|Replace|Prefer|Push|Keep|Check|Review)\b[^\n]*?)(?:\.(?:\s|$)|$)/i,
  )?.[1];
  return shorten(
    'Review: ' + cleanLine(action || comparison.note || comparison.message || comparison.after.split('\n')[0]),
  );
}

module.exports = { getFindingComparison, inlineComparison };
