// Turns checker reports into language server diagnostics and hovers. Each published diagnostic keeps
// an anchor with what the code actions, code lenses and hovers need: the reported site, the
// scanner's fix and the dismissal entry.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DiagnosticSeverity } from 'vscode-languageserver';
import type { Diagnostic, DiagnosticRelatedInformation, Position, Range } from 'vscode-languageserver';
import { exampleFor as reliabilityExample } from './reliability-examples.js';
import { exampleFor as maintainabilityExample } from './maintainability-examples.js';
import { exampleFor as securityExample } from './security-examples.js';
import { exampleFor as accessibilityExample } from './accessibility-examples.js';
import { getFindingComparison, inlineComparison } from './finding-comparison.js';
import { rangeContains, samePosition, validateRange, wordRangeAt } from './editor-document.js';
import { isRealPathInside } from './workspace-paths.js';
import { pillarOfRule } from '../shared/rule-registry.js';
import { documentationUrl } from '../shared/formats/sarif.js';
import type { EditorDocument } from './editor-document.js';
import type { Finding, FindingFix, FixChange } from '../shared/types.js';
import type { Comparison, CodeComparison } from './types/comparison.js';
import type { DismissalEntry } from './types/dismissal.js';
import type { FixExample } from './types/fix-example.js';

/** A change with the absolute file it applies to. */
export interface WorkspaceChange extends FixChange {
  filename: string;
}

/** A site fix whose files are all inside the workspace folder. */
export interface WorkspaceFix {
  changes: WorkspaceChange[];
  note: string | undefined;
  requiresReview: boolean;
}

/** What the server remembers of a published finding. */
export interface DiagnosticAnchor {
  source: string;
  ruleId: string;
  line: number;
  column: number;
  message: string;
  suggestion: unknown;
  comparison: unknown;
  fix: WorkspaceFix | undefined;
  dismissal: DismissalEntry;
}

/** A diagnostic as sent to the editor, with the file it belongs to and its anchor. */
export interface PublishedFinding {
  filename: string;
  uri: string;
  diagnostic: Diagnostic;
  anchor: DiagnosticAnchor;
}

export interface PublishOptions {
  isDismissed?(entry: DismissalEntry): boolean;
  /** The loadwise.severity setting: one level for every finding, or 'default'. */
  severity?: string;
  /** The open buffer or the file on disk; undefined when the file does not exist. */
  documentFor(filename: string): EditorDocument | undefined;
  /** The URI the editor uses for a file, so an open buffer gets its own diagnostics. */
  uriFor?(filename: string): string;
}

/** Where a finding is, once it is known to point at a real line and column. */
interface LocatedSite {
  file: string;
  line: number;
  column: number;
}

interface FileLocation {
  filename: string;
  uri: string;
  range: Range;
}

const maintainabilitySource = 'loadwise maint';
const severityNames: Readonly<Record<string, DiagnosticSeverity>> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  information: DiagnosticSeverity.Information,
  hint: DiagnosticSeverity.Hint,
};
const polyglotLanguages = new Set(['python', 'go', 'java', 'csharp', 'rust', 'php', 'ruby', 'kotlin', 'c', 'cpp']);

const contracts = new Set([
  'pg-transaction-on-pool',
  'folder-boundary',
  'file-placement',
  'query-mutates-state',
  'data-access-boundary',
]);

const advice = new Map([
  [
    'dependency-cycle',
    'Follow the imports in the reported cycle. Move a shared dependency into a module that both sides can import, or pass it to the caller explicitly.',
  ],
  [
    'folder-boundary',
    'Use an API the importing layer is allowed to call, or move the code that needs this dependency into the layer that owns it.',
  ],
  ['file-placement', 'Move the file to one of the configured folders and update its imports.'],
]);

function sourceExample(ruleId: string, languageId: string, message: string): FixExample | undefined {
  // Reliability examples fall back to the performance ones, so one lookup covers the shared source pass.
  return (
    reliabilityExample(ruleId, languageId, message) ??
    securityExample(ruleId, languageId) ??
    accessibilityExample(ruleId, languageId)
  );
}

// ast-grep counts Unicode code points; editor positions and TypeScript use UTF-16.
function utf16Column(document: EditorDocument, line: number, codePoints: number): number {
  let remaining = codePoints;
  let column = 0;
  for (const character of document.lineAt(line).text) {
    if (remaining === 0) break;
    column += character.length;
    remaining--;
  }
  return column;
}

function sourceRange(site: Pick<LocatedSite, 'line' | 'column'>, document: EditorDocument | undefined): Range {
  const line = site.line - 1;
  let column = site.column - 1;
  if (document && polyglotLanguages.has(document.languageId) && line < document.lineCount && column > 0) {
    column = utf16Column(document, line, column);
  }
  const anchor = { start: { line, character: column }, end: { line, character: column + 1 } };
  if (!document) return anchor;
  const range = validateRange(document, anchor);
  const word = wordRangeAt(document, range.start);
  return word && samePosition(word.start, range.start) ? word : range;
}

const sentenceEnds = '.!?';

// Findings are written as short paragraphs; one sentence per line is easier to read in a tooltip.
// Code spans are kept whole, and a break needs a capital, backtick or parenthesis after the space,
// so "e.g. x" stays together.
function sentenceLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  let inCode = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '`') inCode = !inCode;
    else if (
      !inCode &&
      sentenceEnds.includes(character) &&
      text[index + 1] === ' ' &&
      /[A-Z`(]/.test(text[index + 2] ?? '')
    ) {
      lines.push(text.slice(start, index + 1));
      start = index + 2;
    }
  }
  lines.push(text.slice(start));
  return lines.map((line) => line.trim()).filter(Boolean);
}

function readable(text: string): string {
  return text.split('\n').flatMap(sentenceLines).join('\n');
}

function dedent(text: string): string {
  const lines = text.split('\n');
  const width = Math.min(...lines.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0));
  return lines.map((line) => line.slice(width)).join('\n');
}

// The scanner's rewrite of this exact code; the generic rule example is only a fallback.
function fixComparison(fix: Pick<FindingFix, 'changes' | 'note' | 'requiresReview'>): CodeComparison {
  const shown = fix.changes.find((change) => !change.create) ?? fix.changes[0];
  const others = fix.changes.filter((change) => change !== shown);
  const created = others.filter((change) => change.create).map((change) => change.file);
  const edited = others.length - created.length;
  const more =
    (edited ? ' Also changes ' + edited + ' more place(s).' : '') +
    (created.length ? ' Also creates ' + created.join(', ') + '.' : '');
  return {
    kind: 'source',
    before: shown.create ? '(new file ' + shown.file + ')' : dedent(shown.before),
    after: shown.create ? shown.after.trimEnd() : dedent(shown.after),
    note: (
      (fix.note ?? '') +
      more +
      (fix.requiresReview ? ' Review this change and apply it individually.' : '') +
      ' Use the Apply fix code action or the code lens above the line.'
    ).trim(),
  };
}

function examplesFor(
  document: EditorDocument,
  range: Range,
  anchor: DiagnosticAnchor,
): { example: FixExample | undefined; comparison: Comparison | undefined } {
  // Every source checker but maintainability shares the source examples, which fall back to the
  // security ones.
  const lookup = anchor.source === maintainabilitySource ? maintainabilityExample : sourceExample;
  const example = lookup(anchor.ruleId, document.languageId, anchor.message);
  if (anchor.fix) return { example, comparison: fixComparison(anchor.fix) };
  const comparison = getFindingComparison(
    document,
    {
      source: anchor.source,
      code: anchor.ruleId,
      message: anchor.message,
      suggestion: anchor.suggestion,
      comparison: anchor.comparison,
      range,
    },
    example,
  );
  return { example, comparison };
}

/** The one-line recommendation shown before the finding, or undefined without a comparison. */
function recommendation(document: EditorDocument, range: Range, anchor: DiagnosticAnchor): string | undefined {
  const { comparison } = examplesFor(document, range, anchor);
  const preview = comparison && inlineComparison(comparison);
  if (!comparison || !preview) return;
  return (comparison.kind === 'source' ? 'Code: ' : '') + preview;
}

function isLocatedSite(site: unknown): site is LocatedSite {
  if (typeof site !== 'object' || site === null) return false;
  if (!('file' in site) || !('line' in site) || !('column' in site)) return false;
  return (
    typeof site.file === 'string' &&
    site.file !== '' &&
    !site.file.includes('\0') &&
    typeof site.line === 'number' &&
    Number.isSafeInteger(site.line) &&
    site.line >= 1 &&
    typeof site.column === 'number' &&
    Number.isSafeInteger(site.column) &&
    site.column >= 1
  );
}

function insideRoot(rootPath: string, file: string): string | undefined {
  const filename = path.resolve(rootPath, file);
  const relative = path.relative(rootPath, filename);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;
  return filename;
}

function defaultUri(filename: string): string {
  return pathToFileURL(filename).href;
}

function location(rootPath: string, site: unknown, options: PublishOptions): FileLocation | undefined {
  if (!isLocatedSite(site)) return;
  const filename = insideRoot(rootPath, site.file);
  if (filename === undefined) return;
  const uri = (options.uriFor ?? defaultUri)(filename);
  return { filename, uri, range: sourceRange(site, options.documentFor(filename)) };
}

// Resolves each change of a site fix inside the workspace folder; a path outside it, also through a
// symbolic link, drops the whole fix.
function workspaceFix(rootPath: string, fix: FindingFix | undefined): WorkspaceFix | undefined {
  if (!fix || !Array.isArray(fix.changes) || !fix.changes.length) return;
  const changes: WorkspaceChange[] = [];
  for (const change of fix.changes) {
    if (
      typeof change?.file !== 'string' ||
      change.file.includes('\0') ||
      typeof change.before !== 'string' ||
      typeof change.after !== 'string'
    )
      return;
    if (!Number.isSafeInteger(change.line) || change.line < 1) return;
    const filename = insideRoot(rootPath, change.file);
    if (filename === undefined || !isRealPathInside(rootPath, filename)) return;
    changes.push({ ...change, filename });
  }
  return {
    changes,
    note: typeof fix.note === 'string' ? fix.note : undefined,
    requiresReview: fix.requiresReview === true,
  };
}

// Every finding is an optional suggestion: a warning by default, an error for a declared contract,
// unless the loadwise.severity setting picks one level for all of them.
function severityFor(finding: Finding, setting: string | undefined): DiagnosticSeverity {
  const isError = finding.level === 'error' || (finding.level !== 'warn' && contracts.has(finding.ruleId));
  const chosen = setting === undefined ? undefined : severityNames[setting];
  return chosen ?? (isError ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning);
}

function readSavedLines(filename: string): string[] {
  try {
    return fs.readFileSync(filename, 'utf8').split(/\r?\n/);
  } catch {
    // A file deleted since the scan has no line text; its findings disappear on the next scan.
    return [];
  }
}

// The trimmed text of the reported line identifies a dismissed finding. An edited buffer no longer
// matches the scan, so its line is read from the saved file.
function flaggedLineText(
  filename: string,
  line: number,
  options: PublishOptions,
  savedLines: Map<string, string[]>,
): string {
  const document = options.documentFor(filename);
  if (document && !document.isDirty) return line <= document.lineCount ? document.lineAt(line - 1).text.trim() : '';
  if (!savedLines.has(filename)) savedLines.set(filename, readSavedLines(filename));
  return ((savedLines.get(filename) ?? [])[line - 1] ?? '').trim();
}

// A live-database finding names a table, not a file. It is shown on the first line of the project's
// package.json, prefixed by the table, and dismissed by table name.
function databaseFinding(finding: Finding): Finding {
  if (finding.file !== undefined || typeof finding.target !== 'string' || typeof finding.message !== 'string')
    return finding;
  return { ...finding, file: 'package.json', line: 1, column: 1, message: finding.target + ': ' + finding.message };
}

function relatedInformation(
  rootPath: string,
  finding: Finding,
  options: PublishOptions,
): DiagnosticRelatedInformation[] | undefined {
  if (!Array.isArray(finding.related)) return;
  const label = finding.ruleId === 'dependency-cycle' ? 'Import in this cycle' : 'Matching implementation';
  return finding.related.flatMap((item: unknown) => {
    const link = location(rootPath, item, options);
    return link ? [{ location: { uri: link.uri, range: link.range }, message: label }] : [];
  });
}

function buildDiagnostic(
  site: FileLocation,
  finding: Finding,
  anchor: DiagnosticAnchor,
  options: PublishOptions,
): Diagnostic {
  const document = options.documentFor(site.filename);
  const preview = document && recommendation(document, site.range, anchor);
  const diagnostic: Diagnostic = {
    range: site.range,
    message: preview ? preview + '\n' + anchor.message : anchor.message,
    severity: severityFor(finding, options.severity),
    source: anchor.source,
    code: finding.ruleId,
  };
  if (pillarOfRule(finding.ruleId)) diagnostic.codeDescription = { href: documentationUrl + '#' + finding.ruleId };
  return diagnostic;
}

function publishedFinding(
  rootPath: string,
  source: string,
  reported: Finding,
  options: PublishOptions,
  savedLines: Map<string, string[]>,
): PublishedFinding | undefined {
  const finding = databaseFinding(reported);
  if (!isLocatedSite(finding) || typeof finding.message !== 'string' || typeof finding.ruleId !== 'string') return;
  const site = location(rootPath, finding, options);
  if (!site) return;
  const lineText =
    finding === reported
      ? flaggedLineText(site.filename, finding.line, options, savedLines)
      : typeof finding.target === 'string'
        ? finding.target
        : undefined;
  const dismissal: DismissalEntry = { file: site.filename, ruleId: finding.ruleId, lineText };
  if (options.isDismissed?.(dismissal)) return;
  const anchor: DiagnosticAnchor = {
    source,
    ruleId: finding.ruleId,
    line: finding.line,
    column: finding.column,
    message: readable(
      [finding.message, advice.get(finding.ruleId), finding.contextualReason].filter(Boolean).join('\n'),
    ),
    suggestion: finding.suggestion,
    comparison: finding.comparison,
    fix: workspaceFix(rootPath, finding.fix),
    dismissal,
  };
  const diagnostic = buildDiagnostic(site, finding, anchor, options);
  const related = relatedInformation(rootPath, finding, options);
  if (related) diagnostic.relatedInformation = related;
  return { filename: site.filename, uri: site.uri, diagnostic, anchor };
}

/** The diagnostics of one checker report, skipping findings outside the folder or dismissed. */
function buildDiagnostics(
  rootPath: string,
  source: string,
  findings: readonly Finding[],
  options: PublishOptions,
): PublishedFinding[] {
  const savedLines = new Map<string, string[]>();
  return findings.flatMap((finding) => publishedFinding(rootPath, source, finding, options, savedLines) ?? []);
}

// The editor renders hovers as markdown; finding text is shown literally.
function escapeMarkdown(text: string): string {
  return text.replaceAll(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

function paragraphs(text: string): string {
  return readable(text).split('\n').map(escapeMarkdown).join('\n\n');
}

function codeBlock(code: string, language: string): string {
  const longestFence = Math.max(2, ...[...code.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longestFence + 1);
  return fence + language + '\n' + code + '\n' + fence;
}

function comparisonMarkdown(
  comparison: Comparison,
  example: FixExample | undefined,
  document: EditorDocument,
  ruleId: string,
): string[] {
  const label = (comparison.kind === 'source' ? 'Current code' : 'Flagged line') + ' (' + ruleId + ')';
  const parts = [escapeMarkdown(label), codeBlock(comparison.before, document.languageId)];
  if (comparison.kind === 'review') parts.push(escapeMarkdown('Review: ' + comparison.inline));
  else {
    parts.push(comparison.kind === 'source' ? 'Suggested rewrite' : 'Illustrative alternative');
    parts.push(codeBlock(comparison.after, comparison.language ?? example?.language ?? document.languageId));
  }
  return parts;
}

function hoverMarkdown(document: EditorDocument, entry: PublishedFinding): string | undefined {
  const { anchor, diagnostic } = entry;
  const { example, comparison } = examplesFor(document, diagnostic.range, anchor);
  if (!comparison && !example) return;
  const parts: string[] = [];
  const firstLine = recommendation(document, diagnostic.range, anchor);
  if (firstLine) parts.push('**' + escapeMarkdown(firstLine) + '**');
  parts.push(paragraphs(anchor.message));
  if (comparison) parts.push(...comparisonMarkdown(comparison, example, document, anchor.ruleId));
  else if (example) {
    parts.push(
      escapeMarkdown('Illustrative alternative (' + anchor.ruleId + ')'),
      codeBlock(example.code, example.language),
    );
  }
  const note = comparison ? comparison.note : example?.note;
  if (note) parts.push(paragraphs(note));
  return parts.join('\n\n');
}

/** The hover for a position: one section per rule flagged there, or undefined. */
function hoverFor(
  document: EditorDocument,
  entries: readonly PublishedFinding[],
  position: Position,
): { markdown: string; range: Range } | undefined {
  const sections: string[] = [];
  const shown = new Set<string>();
  let hoverRange: Range | undefined;
  const word = wordRangeAt(document, position);
  for (const entry of entries) {
    const issueRange = entry.diagnostic.range;
    const range = word && samePosition(word.start, issueRange.start) ? word : issueRange;
    if (!rangeContains(range, position) || shown.has(entry.anchor.ruleId)) continue;
    const markdown = hoverMarkdown(document, entry);
    if (!markdown) continue;
    sections.push(markdown);
    shown.add(entry.anchor.ruleId);
    hoverRange ??= range;
  }
  if (!sections.length || !hoverRange) return;
  return { markdown: sections.join('\n\n---\n\n'), range: hoverRange };
}

export { buildDiagnostics, hoverFor };
