// @ts-check
import type { Node, SourceFile, StringLiteral } from 'typescript';
import { findLineIndex } from '../performance/sql/locations.js';
import { scriptFile } from './fix-presentation-prettier.js';
import { splitRows } from './fix-presentation-rows.js';
import type { TextEdit } from './types.js';
import type { FileStyle, IndentedRow, StyleRegion, TypeScript } from './types/fix-presentation.js';

// Without Prettier, the changed rows of a fix take the file's own style: its semicolons,
// indentation and string quotes, read from the rows no fix wrote. A style the file does not clearly
// follow stays as the fix wrote it.
const dominantShare = 0.8;
const minimumStyleSamples = 3;
// Fix builders indent nested code by this many spaces on top of the indentation they copy from the
// file.
const builtIndentWidth = 2;
const quoteCharacters = ['"', "'"];
// A statement starting with one of these would continue the one before it once that one's semicolon
// is gone.
const continuationStarts = new Set(['(', '[', '`', '+', '-', '/', '<', '.', '*']);

// The style the samples clearly follow, or undefined.
function dominantStyle<Style>(counts: ReadonlyMap<Style, number>): Style | undefined {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (total < minimumStyleSamples) return;
  for (const [style, count] of counts) if (count / total >= dominantShare) return style;
}

function countStyle<Style>(counts: Map<Style, number>, style: Style): void {
  counts.set(style, (counts.get(style) ?? 0) + 1);
}

// Statements that end in a semicolon when the file writes them.
const semicolonStatement = (ts: TypeScript, node: Node): boolean =>
  ts.isExpressionStatement(node) ||
  ts.isVariableStatement(node) ||
  ts.isReturnStatement(node) ||
  ts.isThrowStatement(node) ||
  ts.isBreakStatement(node) ||
  ts.isContinueStatement(node) ||
  ts.isDebuggerStatement(node) ||
  ts.isImportDeclaration(node) ||
  ts.isImportEqualsDeclaration(node) ||
  ts.isExportDeclaration(node) ||
  ts.isExportAssignment(node) ||
  ts.isTypeAliasDeclaration(node);

const indentationOf = (row: string): string => /^[ \t]*/.exec(row)?.[0] ?? '';

// A tab, the file's run of spaces per level, or undefined.
function indentationStyle(samples: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  const steps = new Map<number, number>();
  let previousWidth = 0;
  for (const indentation of samples) {
    if (/^\t+$/.test(indentation)) countStyle(counts, '\t');
    else if (/^ +$/.test(indentation)) {
      countStyle(counts, ' ');
      if (indentation.length > previousWidth) countStyle(steps, indentation.length - previousWidth);
      previousWidth = indentation.length;
    }
  }
  const style = dominantStyle(counts);
  if (style !== ' ') return style;
  const width = [...steps].sort((left, right) => right[1] - left[1])[0]?.[0];
  return width ? ' '.repeat(width) : undefined;
}

// Re-indents the changed rows of a region that a builder nested in its own two-space unit, relative
// to the region's first row, whose indentation was copied from the file.
function indentationEdits(
  region: StyleRegion,
  rows: readonly string[],
  lineStarts: readonly number[],
  editable: (row: number) => boolean,
  style: string | undefined,
): TextEdit[] {
  if (!style || style === ' '.repeat(builtIndentWidth)) return [];
  const firstRow = rows.slice(region.start, region.end).findIndex((row) => row.trim());
  if (firstRow === -1) return [];
  const base = indentationOf(rows[region.start + firstRow]);
  const nested: IndentedRow[] = [];
  for (let row = region.start; row < region.end; row++) {
    const indentation = indentationOf(rows[row]);
    if (!editable(row) || !rows[row].trim() || !indentation.startsWith(base)) continue;
    const extra = indentation.slice(base.length);
    if (/^ +$/.test(extra) && extra.length % builtIndentWidth === 0) nested.push({ row, indentation, extra });
  }
  // Nesting only in steps of twice the builder's unit may already be the file's own four spaces.
  if (!nested.some(({ extra }) => extra.length % (2 * builtIndentWidth) === builtIndentWidth)) return [];
  return nested.map(({ row, indentation, extra }) => ({
    start: lineStarts[row],
    end: lineStarts[row] + indentation.length,
    text: base + style.repeat(extra.length / builtIndentWidth),
  }));
}

// The file's own style, from the code outside `regions`.
function fileStyle(
  ts: TypeScript,
  sourceFile: SourceFile,
  rows: readonly string[],
  outside: (row: number) => boolean,
): FileStyle {
  const { text } = sourceFile;
  const lineStarts = sourceFile.getLineStarts();
  const rowAt = (offset: number) => findLineIndex(lineStarts, offset);
  // Rows that start inside a string, template or comment, whose leading space belongs to that text.
  const insideText = new Set<number>();
  const protect = (start: number, end: number) => {
    for (let row = rowAt(start) + 1; row <= rowAt(end); row++) insideText.add(row);
  };
  const nodeStarts = new Set<number>();
  const statements: Node[] = [];
  const strings: StringLiteral[] = [];
  const visit = (node: Node): void => {
    const start = node.getStart(sourceFile);
    nodeStarts.add(start);
    for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) protect(range.pos, range.end);
    if (ts.isStringLiteral(node) || ts.isTemplateLiteral(node) || ts.isJsxText(node)) protect(start, node.end);
    if (semicolonStatement(ts, node)) statements.push(node);
    if (ts.isStringLiteral(node) && !ts.isJsxAttribute(node.parent)) strings.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  const indentSamples: string[] = [];
  rows.forEach((row: string, index: number) => {
    const indentation = indentationOf(row);
    if (!outside(index) || insideText.has(index) || !row.trim()) return;
    if (nodeStarts.has(lineStarts[index] + indentation.length)) indentSamples.push(indentation);
  });
  const semicolonCounts = new Map<boolean, number>();
  for (const statement of statements) {
    if (outside(rowAt(statement.end - 1))) countStyle(semicolonCounts, text[statement.end - 1] === ';');
  }
  const quoteCounts = new Map<string, number>();
  for (const literal of strings) {
    const raw = literal.getText(sourceFile);
    // A string holding a quote has its quotes chosen for it.
    if (
      !outside(rowAt(literal.getStart(sourceFile))) ||
      quoteCharacters.some((quote) => raw.slice(1, -1).includes(quote))
    )
      continue;
    if (quoteCharacters.includes(raw[0])) countStyle(quoteCounts, raw[0]);
  }
  return {
    insideText,
    statements,
    strings,
    semicolons: dominantStyle(semicolonCounts),
    quote: dominantStyle(quoteCounts),
    indentation: indentationStyle(indentSamples),
  };
}

// Adds or drops the semicolon ending each changed statement. One is dropped only where the next
// code starts on a later line and could not continue the statement.
function semicolonEdits(
  ts: TypeScript,
  sourceFile: SourceFile,
  statements: readonly Node[],
  changedAt: (offset: number) => boolean,
  semicolons: boolean | undefined,
): TextEdit[] {
  if (semicolons === undefined) return [];
  const { text } = sourceFile;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, sourceFile.languageVariant, text);
  const edits: TextEdit[] = [];
  for (const { end } of statements) {
    const hasSemicolon = text[end - 1] === ';';
    if (!changedAt(end - 1) || semicolons === hasSemicolon) continue;
    if (semicolons) {
      edits.push({ start: end, end, text: ';' });
      continue;
    }
    scanner.setTextPos(end);
    const token = scanner.scan();
    const closes = token === ts.SyntaxKind.EndOfFileToken || token === ts.SyntaxKind.CloseBraceToken;
    if (!closes && (!scanner.hasPrecedingLineBreak() || continuationStarts.has(scanner.getTokenText()[0]))) continue;
    edits.push({ start: end - 1, end, text: '' });
  }
  return edits;
}

// Swaps the quotes of changed strings that hold no quote, so no escape changes.
function quoteEdits(
  sourceFile: SourceFile,
  strings: readonly StringLiteral[],
  changedAt: (offset: number) => boolean,
  quote: string | undefined,
): TextEdit[] {
  if (!quote) return [];
  const edits: TextEdit[] = [];
  for (const literal of strings) {
    const start = literal.getStart(sourceFile);
    const raw = sourceFile.text.slice(start, literal.end);
    const body = raw.slice(1, -1);
    if (raw[0] === quote || !quoteCharacters.includes(raw[0]) || !changedAt(start) || !changedAt(literal.end - 1))
      continue;
    if (!quoteCharacters.some((character) => body.includes(character)))
      edits.push({ start, end: literal.end, text: quote + body + quote });
  }
  return edits;
}

// The text with the changed rows of `regions` in the file's own style. A row equal to one its
// change replaced is unchanged code and keeps its text. Never adds or removes a row, so row
// ownership still holds.
function matchFileStyle(loadTs: () => TypeScript, file: string, text: string, regions: readonly StyleRegion[]): string {
  if (!scriptFile.test(file) || !regions.length) return text;
  const ts = loadTs();
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  if (sourceFile.parseDiagnostics?.length) return text;
  const lineStarts = sourceFile.getLineStarts();
  const rows = splitRows(text);
  const regionByRow = new Map<number, StyleRegion>();
  for (const region of regions) for (let row = region.start; row < region.end; row++) regionByRow.set(row, region);
  const withoutReturn = (row: string): string => row.replace(/\r$/, '');
  const changed = (row: number): boolean => {
    const region = regionByRow.get(row);
    if (!region) return false;
    return !region.beforeRows.some((before: string) => withoutReturn(before) === withoutReturn(rows[row]));
  };
  const changedAt = (offset: number): boolean => changed(findLineIndex(lineStarts, offset));
  const style = fileStyle(ts, sourceFile, rows, (row: number) => !regionByRow.has(row));
  const reindentable = (row: number): boolean => changed(row) && !style.insideText.has(row);
  const edits = [
    ...semicolonEdits(ts, sourceFile, style.statements, changedAt, style.semicolons),
    ...quoteEdits(sourceFile, style.strings, changedAt, style.quote),
    ...regions.flatMap((region: StyleRegion) =>
      indentationEdits(region, rows, lineStarts, reindentable, style.indentation),
    ),
  ];
  if (!edits.length) return text;
  let styled = text;
  for (const edit of edits.sort((left, right) => right.start - left.start || right.end - left.end)) {
    styled = styled.slice(0, edit.start) + edit.text + styled.slice(edit.end);
  }
  return ts.createSourceFile(file, styled, ts.ScriptTarget.Latest).parseDiagnostics?.length ? text : styled;
}

export { matchFileStyle };
