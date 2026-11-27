import * as ts from 'typescript';
import type { FixChange } from './types.js';

export interface ImportEdit {
  moduleSpecifier: string;
  named?: readonly string[];
  defaultName?: string;
  namespaceName?: string;
  isTypeOnly?: boolean;
}

interface ParsedImportLine {
  moduleSpecifier: string;
  named: string[];
  defaultName?: string;
  namespaceName?: string;
  isTypeOnly: boolean;
}

function parseImportStatement(statement: ts.ImportDeclaration): ParsedImportLine | undefined {
  if (!ts.isStringLiteral(statement.moduleSpecifier)) return;
  const moduleSpecifier = statement.moduleSpecifier.text;
  const clause = statement.importClause;
  if (!clause) return { moduleSpecifier, named: [], isTypeOnly: false };
  const isTypeOnly = Boolean(clause.isTypeOnly);
  const defaultName = clause.name?.text;
  const named: string[] = [];
  let namespaceName: string | undefined;
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      namespaceName = clause.namedBindings.name.text;
    } else if (ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const imported = element.propertyName
          ? `${element.propertyName.text} as ${element.name.text}`
          : element.name.text;
        named.push(imported);
      }
    }
  }
  return { moduleSpecifier, named, defaultName, namespaceName, isTypeOnly };
}

function formatImport(entry: ParsedImportLine): string {
  const prefix = entry.isTypeOnly ? 'import type ' : 'import ';
  const parts: string[] = [];
  if (entry.defaultName) parts.push(entry.defaultName);
  if (entry.namespaceName) parts.push(`* as ${entry.namespaceName}`);
  if (entry.named.length) parts.push(`{ ${[...new Set(entry.named)].join(', ')} }`);
  if (!parts.length) return `${prefix}'${entry.moduleSpecifier}';`;
  return `${prefix}${parts.join(', ')} from '${entry.moduleSpecifier}';`;
}

function mergeEditIntoParsed(target: ParsedImportLine, edit: ImportEdit): void {
  if (edit.defaultName && !target.defaultName) target.defaultName = edit.defaultName;
  if (edit.namespaceName && !target.namespaceName) target.namespaceName = edit.namespaceName;
  if (edit.named?.length) target.named.push(...edit.named);
}

function newImportInsertion(
  text: string,
  source: ts.SourceFile,
  existingImports: readonly ts.ImportDeclaration[],
  lines: readonly string[],
): { start: number; text: string } {
  const joined = lines.join('\n');
  if (existingImports.length) {
    const last = existingImports[existingImports.length - 1];
    return { start: last.getEnd(), text: `\n${joined}` };
  }
  let lastDirective: ts.ExpressionStatement | undefined;
  for (const stmt of source.statements) {
    if (!ts.isExpressionStatement(stmt) || !ts.isStringLiteralLike(stmt.expression)) break;
    lastDirective = stmt;
  }
  if (lastDirective) {
    return { start: lastDirective.getEnd(), text: `\n${joined}` };
  }
  const shebang = /^#![^\n]*\r?\n/.exec(text);
  if (shebang) {
    return { start: shebang[0].length, text: `${joined}\n` };
  }
  return { start: 0, text: `${joined}\n` };
}

/**
 * Merges structured `ImportEdit`s into existing import declarations in `text` (or inserts a single
 * import per module specifier after any leading shebang, directive prologues, or existing imports)
 * without creating duplicate imports.
 */
export function applyImportEdits(text: string, edits: readonly ImportEdit[], fileName = 'file.ts'): string {
  if (!edits.length) return text;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const existingImports = source.statements.filter(ts.isImportDeclaration);
  const matchedReplacements = new Map<ts.ImportDeclaration, ParsedImportLine>();
  const mergedNew = new Map<string, ParsedImportLine>();

  for (const edit of edits) {
    const wantsNamed = Boolean(edit.named?.length);
    const wantsNamespace = Boolean(edit.namespaceName);
    const match = existingImports.find((decl) => {
      if (
        !ts.isStringLiteral(decl.moduleSpecifier) ||
        decl.moduleSpecifier.text !== edit.moduleSpecifier ||
        Boolean(decl.importClause?.isTypeOnly) !== Boolean(edit.isTypeOnly)
      ) {
        return false;
      }
      const bindings = decl.importClause?.namedBindings;
      const hasNamespace = Boolean(bindings && ts.isNamespaceImport(bindings));
      const hasNamed = Boolean(bindings && ts.isNamedImports(bindings));
      // JS/TS forbids combining `* as ns` and `{ named }` in one import declaration.
      if (wantsNamed && hasNamespace) return false;
      if (wantsNamespace && hasNamed) return false;
      return true;
    });
    const parsed = match ? (matchedReplacements.get(match) ?? parseImportStatement(match)) : undefined;
    if (match && parsed) {
      mergeEditIntoParsed(parsed, edit);
      matchedReplacements.set(match, parsed);
      continue;
    }
    const key = `${edit.isTypeOnly ? 'type:' : ''}${wantsNamespace ? 'ns:' : ''}${edit.moduleSpecifier}`;
    const current = mergedNew.get(key) ?? {
      moduleSpecifier: edit.moduleSpecifier,
      named: [],
      isTypeOnly: Boolean(edit.isTypeOnly),
    };
    mergeEditIntoParsed(current, edit);
    mergedNew.set(key, current);
  }

  const textEdits = [...matchedReplacements.entries()].map(([decl, parsed]) => ({
    start: decl.getStart(source),
    end: decl.getEnd(),
    text: formatImport(parsed),
  }));
  if (mergedNew.size) {
    const insertion = newImportInsertion(text, source, existingImports, [...mergedNew.values()].map(formatImport));
    textEdits.push({ start: insertion.start, end: insertion.start, text: insertion.text });
  }
  let result = text;
  for (const rep of textEdits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, rep.start) + rep.text + result.slice(rep.end);
  }
  return result;
}

function parsePureImportBlock(text: string): ImportEdit[] | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const source = ts.createSourceFile('import-edit.ts', trimmed, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics?.length || !source.statements.length) return undefined;
  const edits: ImportEdit[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) return undefined;
    const parsed = parseImportStatement(statement);
    if (!parsed) return undefined;
    edits.push(parsed);
  }
  return edits;
}

function isPureImportChange(change: FixChange): boolean {
  if (change.create || change.line !== 1) return false;
  if (change.before !== '' && !parsePureImportBlock(change.before)) return false;
  return Boolean(parsePureImportBlock(change.after));
}

/**
 * Coalesces multiple line-1 pure-import `FixChange`s targeting the same file into a single
 * non-colliding `FixChange` using AST-level import merging.
 */
export function coalesceImportChanges(
  changes: readonly FixChange[],
  readText: (file: string) => string | undefined,
): FixChange[] {
  const byFile = new Map<string, FixChange[]>();
  const passthrough: FixChange[] = [];

  for (const change of changes) {
    if (isPureImportChange(change)) {
      const list = byFile.get(change.file) ?? [];
      list.push(change);
      byFile.set(change.file, list);
      continue;
    }
    passthrough.push(change);
  }

  const coalesced: FixChange[] = [...passthrough];
  for (const [file, group] of byFile) {
    const existingText = readText(file) ?? '';
    const edits = group.flatMap((change) => parsePureImportBlock(change.after) ?? []);
    if (group.length === 1) {
      const source = ts.createSourceFile(file, existingText, ts.ScriptTarget.Latest, true);
      const specifiers = new Set(edits.map((edit) => edit.moduleSpecifier));
      const hasMatchingImport = source.statements.some(
        (stmt) =>
          ts.isImportDeclaration(stmt) &&
          ts.isStringLiteral(stmt.moduleSpecifier) &&
          specifiers.has(stmt.moduleSpecifier.text),
      );
      const hasLeadingHeader =
        existingText.startsWith('#!') ||
        Boolean(
          source.statements[0] &&
          ts.isExpressionStatement(source.statements[0]) &&
          ts.isStringLiteralLike(source.statements[0].expression),
        );
      if (!hasMatchingImport && !hasLeadingHeader) {
        coalesced.push(group[0]);
        continue;
      }
    }
    const updated = applyImportEdits(existingText, edits, file);
    if (updated === existingText) continue;
    const existingLines = existingText.replaceAll('\r\n', '\n').split('\n');
    const updatedLines = updated.replaceAll('\r\n', '\n').split('\n');
    // Compute minimal line-1 prefix/suffix diff for applyFix.
    let suffix = 0;
    while (
      suffix < existingLines.length &&
      suffix < updatedLines.length &&
      existingLines[existingLines.length - 1 - suffix] === updatedLines[updatedLines.length - 1 - suffix]
    ) {
      suffix++;
    }
    const beforeSlice = existingLines.slice(0, existingLines.length - suffix).join('\n');
    const afterSlice = updatedLines.slice(0, updatedLines.length - suffix).join('\n');
    coalesced.push({ file, line: 1, before: beforeSlice, after: afterSlice });
  }
  return coalesced;
}

export { isPureImportChange };
