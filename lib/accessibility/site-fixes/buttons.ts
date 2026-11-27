import type { FixResult, SiteFixBuilder, SiteFixInput } from '../../shared/types.js';

const buttonTagOpening = '<button';
const typeAttribute = ' type="button"';
const tagNameCharacter = /[\w.:-]/;

// Works on the raw text so one builder serves JSX files and markup files (.html, .vue, .svelte).
function offsetOf(text: string, line: number, column: number): number | undefined {
  let offset = 0;
  for (let currentLine = 1; currentLine < line; currentLine++) {
    const newline = text.indexOf('\n', offset);
    if (newline === -1) return;
    offset = newline + 1;
  }
  return offset + column - 1;
}

function buttonTypeFix({ finding, text, load }: SiteFixInput): FixResult | undefined {
  const { file, line, column } = finding;
  if (line === undefined || column === undefined) return;
  const source = text ?? (typeof file === 'string' ? load(file)?.text : undefined);
  if (source === undefined) return;
  const start = offsetOf(source, line, column);
  if (start === undefined || !source.startsWith(buttonTagOpening, start)) return;
  const tagNameEnd = start + buttonTagOpening.length;
  if (tagNameCharacter.test(source.charAt(tagNameEnd))) return;
  return {
    edits: [{ start: tagNameEnd, end: tagNameEnd, text: typeAttribute }],
    note: 'type="button" stops the button from submitting its form; a button meant to submit the form needs type="submit" instead.',
    requiresReview: true,
  };
}

const builders: Record<string, SiteFixBuilder> = { 'a11y-button-missing-type': buttonTypeFix };

export default builders;
