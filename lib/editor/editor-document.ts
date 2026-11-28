// The text of a source file as the language server sees it: the editor's open buffer when there is
// one, otherwise the file on disk. Diagnostics, hovers and fixes all read files through this shape.
import fs from 'node:fs';
import path from 'node:path';
import type { Position, Range } from 'vscode-languageserver';
import type { SourceDocument } from './types/source-document.js';

export interface EditorDocument extends SourceDocument {
  filename: string;
  /** The open buffer's version, or null for text read from disk. */
  version: number | null;
  eol: '\n' | '\r\n';
  getText(): string;
}

interface DocumentOptions {
  languageId?: string;
  version?: number | null;
  isDirty?: boolean;
}

const languageBySuffix: Readonly<Record<string, string>> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascriptreact',
  py: 'python',
  go: 'go',
  java: 'java',
  cs: 'csharp',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  sql: 'sql',
  json: 'json',
  prisma: 'prisma',
  html: 'html',
  vue: 'vue',
  svelte: 'svelte',
};

// VS Code's default word definition, so a diagnostic covers the same token in every editor.
const wordPattern = /(-?\d*\.\d\w*)|([^`~!@#$%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g;

function languageIdOf(filename: string): string {
  return languageBySuffix[path.extname(filename).slice(1).toLowerCase()] ?? 'plaintext';
}

function createEditorDocument(
  filename: string,
  text: string,
  { languageId = languageIdOf(filename), version = null, isDirty = false }: DocumentOptions = {},
): EditorDocument {
  const lines = text.split(/\r?\n/);
  return {
    filename,
    languageId,
    version,
    isDirty,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    lineCount: lines.length,
    lineAt: (line) => ({ text: lines[line] ?? '' }),
    getText: () => text,
  };
}

function readDiskDocument(filename: string): EditorDocument | undefined {
  try {
    return createEditorDocument(filename, fs.readFileSync(filename, 'utf8'));
  } catch {
    // A file deleted since the scan has no text; its findings disappear on the next scan.
    return undefined;
  }
}

function clampPosition(document: EditorDocument, position: Position): Position {
  if (position.line < 0) return { line: 0, character: 0 };
  if (position.line >= document.lineCount) {
    const lastLine = document.lineCount - 1;
    return { line: lastLine, character: document.lineAt(lastLine).text.length };
  }
  const length = document.lineAt(position.line).text.length;
  return { line: position.line, character: Math.max(0, Math.min(position.character, length)) };
}

function validateRange(document: EditorDocument, range: Range): Range {
  return { start: clampPosition(document, range.start), end: clampPosition(document, range.end) };
}

function wordRangeAt(document: EditorDocument, position: Position): Range | undefined {
  if (position.line < 0 || position.line >= document.lineCount) return;
  const text = document.lineAt(position.line).text;
  for (const match of text.matchAll(wordPattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start <= position.character && position.character <= end) {
      return { start: { line: position.line, character: start }, end: { line: position.line, character: end } };
    }
  }
}

function samePosition(left: Position, right: Position): boolean {
  return left.line === right.line && left.character === right.character;
}

function comparePositions(left: Position, right: Position): number {
  return left.line - right.line || left.character - right.character;
}

function rangeContains(range: Range, position: Position): boolean {
  return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) <= 0;
}

export { createEditorDocument, rangeContains, readDiskDocument, samePosition, validateRange, wordRangeAt };
