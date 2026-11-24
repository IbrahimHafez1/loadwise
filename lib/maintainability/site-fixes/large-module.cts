import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { Identifier, SourceFile, Statement, TypeElement, TypeNode } from 'typescript';
import type { Finding, TextEdit } from '../../shared/types.cjs';
import type { ModuleCreatingFix } from '../types/created-module.cjs';
import type { StringLiteralImport } from '../types/duplicate-sites.cjs';
import type { ProjectSiteFixInput } from '../types/site-fix-loader.cjs';

// Move a substantial record rather than creating one companion per small type.
const minimumRecordLines = 20;
const maximumRecordLines = 80;
const scalars = new Set([
  ts.SyntaxKind.StringKeyword,
  ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.NumberKeyword,
  ts.SyntaxKind.UndefinedKeyword,
  ts.SyntaxKind.UnknownKeyword,
]);

function selfContainedType(type: TypeNode, source: SourceFile): boolean {
  if (scalars.has(type.kind)) return true;
  if (ts.isTypeLiteralNode(type)) return recordFields(type.members, source);
  if (ts.isArrayTypeNode(type)) return selfContainedType(type.elementType, source);
  if (ts.isUnionTypeNode(type)) return type.types.every((member) => selfContainedType(member, source));
  if (ts.isLiteralTypeNode(type))
    return type.literal.kind === ts.SyntaxKind.NullKeyword || ts.isStringLiteral(type.literal);
  if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName) || source.locals?.has(type.typeName.escapedText))
    return false;
  if (type.typeName.text === 'Date') return !type.typeArguments;
  return (
    ['Array', 'ReadonlyArray'].includes(type.typeName.text) &&
    type.typeArguments?.length === 1 &&
    selfContainedType(type.typeArguments[0], source)
  );
}

function recordFields(members: readonly TypeElement[], source: SourceFile): boolean {
  return members.every(
    (member) =>
      ts.isPropertySignature(member) &&
      ts.isIdentifier(member.name) &&
      member.type &&
      selfContainedType(member.type, source),
  );
}

// A name listed in `export { Name }` or `export default Name` would become a re-export of an
// import, which isolated modules reject for a type unless it is written `export type`.
function reExported(sourceFile: SourceFile, name: string): boolean {
  return sourceFile.statements.some(
    (statement: Statement) =>
      (ts.isExportAssignment(statement) &&
        ts.isIdentifier(statement.expression) &&
        statement.expression.text === name) ||
      (ts.isExportDeclaration(statement) &&
        !statement.moduleSpecifier &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some((element) => (element.propertyName ?? element.name).text === name)),
  );
}

// The record leaves only when that brings the module back within the rule's limit. A module far
// over it keeps its finding, so moving one record there adds a file without resolving anything.
function resolvesFinding(finding: Finding, recordLines: number): boolean {
  const measured = /has (\d+) lines of code \(limit (\d+)/.exec(finding.message ?? '');
  // The import that replaces the record adds one line.
  return !measured || Number(measured[1]) - recordLines + 1 <= Number(measured[2]);
}

function relativeImports(sourceFile: SourceFile): StringLiteralImport[] {
  return sourceFile.statements.filter(
    (statement): statement is StringLiteralImport =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      /^\.\.?\//.test(statement.moduleSpecifier.text),
  );
}

function projectFile(projectRoot: string, name: string): string {
  try {
    return fs.readFileSync(path.join(projectRoot, name), 'utf8');
  } catch {
    return '';
  }
}

// Node16 and NodeNext resolution, and Node's own ES module loader, require the extension on
// relative imports.
function extensionRequired(projectRoot: string | undefined): boolean {
  if (!projectRoot) return true;
  const config = projectFile(projectRoot, 'tsconfig.json');
  if (/"(?:module|moduleResolution)"\s*:\s*"node(?:16|next)"/i.test(config)) return true;
  return /"type"\s*:\s*"module"/.test(projectFile(projectRoot, 'package.json'));
}

// The companion's specifier written the way the module's other relative imports are written.
function companionSpecifier(stem: string, sourceFile: SourceFile, projectRoot: string | undefined): string {
  const relative = relativeImports(sourceFile).map((statement) => statement.moduleSpecifier.text);
  const withExtension = relative.length
    ? relative.some((specifier: string) => /\.[cm]?js$/.test(specifier))
    : extensionRequired(projectRoot);
  return './' + stem + (withExtension ? '.js' : '');
}

// Deletes the record from the end of the line above, so the edit stays within lines. The blank line
// above goes too when a blank line or the end of the file follows, which leaves one separator, not
// two.
function removalEdit(statement: Statement, sourceFile: SourceFile, text: string): TextEdit {
  const start = statement.getStart(sourceFile);
  const [, lineBreak, blankLine = ''] = /(\r?\n)(\r?\n)?$/.exec(text.slice(0, start)) ?? ['', ''];
  const blankBelow = /^(?:\r?\n\r?\n|\s*$)/.test(text.slice(statement.end));
  return { start: start - lineBreak.length - (blankBelow ? blankLine.length : 0), end: statement.end, text: '' };
}

function importEdits(statement: Statement, sourceFile: SourceFile, text: string, importText: string): TextEdit[] {
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  const lastImport = imports.at(-1);
  if (!lastImport || lastImport.pos > statement.pos)
    return [{ start: statement.getStart(sourceFile), end: statement.end, text: importText }];
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const gap = text.slice(lastImport.end, statement.getStart(sourceFile));
  // A record right below the imports becomes their last line in one edit, which reads as one short
  // hunk.
  if (!gap.trim()) return [{ start: lastImport.end + gap.indexOf('\n') + 1, end: statement.end, text: importText }];
  // Inserted ahead of the last import, the fix's explanatory comment lands on the new import, not
  // on later code.
  const insertion = lastImport.getStart(sourceFile);
  return [{ start: insertion, end: insertion, text: importText + newline }, removalEdit(statement, sourceFile, text)];
}

// A plain, single-declaration record that stands alone on its lines and is the size the finding
// asks to move.
function movableRecord(
  statement: Statement,
  sourceFile: SourceFile,
  text: string,
  finding: Finding,
): { name: Identifier; before: string; count: number } | undefined {
  if (
    (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) ||
    statement.modifiers?.length ||
    statement.typeParameters ||
    (ts.isInterfaceDeclaration(statement) && statement.heritageClauses)
  )
    return;
  const name = statement.name;
  if (reExported(sourceFile, name.text)) return;
  if (sourceFile.locals?.get(name.escapedText)?.declarations?.length !== 1) return;
  const members = ts.isInterfaceDeclaration(statement)
    ? statement.members
    : ts.isTypeLiteralNode(statement.type) && statement.type.members;
  if (!members || !recordFields(members, sourceFile)) return;
  const before = statement.getText(sourceFile);
  const count = before.split('\n').length;
  if (count < minimumRecordLines || count > maximumRecordLines) return;
  if (!resolvesFinding(finding, before.split('\n').filter((line) => line.trim()).length)) return;
  const start = statement.getStart(sourceFile);
  const previousLine = text.lastIndexOf('\n', start - 1) + 1;
  if (previousLine !== start || !/^(?:\r?\n|$)/.test(text.slice(statement.end))) return;
  // Comments with directives or documentation links can refer to the original module.
  if (/\/\/|\/\*/.test(statement.getFullText(sourceFile))) return;
  return { name, before, count };
}

function extractRecord({ sourceFile, text, finding, load }: ProjectSiteFixInput): ModuleCreatingFix | undefined {
  if (!sourceFile || text === undefined || finding.file === undefined) return;
  if (
    !ts.isExternalModule(sourceFile) ||
    sourceFile.isDeclarationFile ||
    !/^[\w.-]+\.ts$/.test(path.basename(finding.file))
  )
    return;
  if (sourceFile.statements.some(ts.isModuleDeclaration)) return;
  const stem = path.basename(finding.file, '.ts') + '.types';
  const siblings = fs.readdirSync(path.dirname(sourceFile.fileName));
  if (
    siblings.some(
      (name) => name.toLowerCase() === stem.toLowerCase() || name.toLowerCase().startsWith(stem.toLowerCase() + '.'),
    )
  )
    return;
  ts.bindSourceFile(sourceFile, {});
  for (const statement of sourceFile.statements) {
    const record = movableRecord(statement, sourceFile, text, finding);
    if (!record) continue;
    const { name, before, count } = record;
    const file = path.posix.join(path.posix.dirname(finding.file.replaceAll('\\', '/')), stem + '.ts');
    return {
      edits: importEdits(
        statement,
        sourceFile,
        text,
        `import type { ${name.text} } from '${companionSpecifier(stem, sourceFile, load.projectRoot)}';`,
      ),
      createdModule: { file, text: 'export ' + before + (text.includes('\r\n') ? '\r\n' : '\n') },
      note: `Moves the ${count}-line private record into a sibling type module. Verify your build includes the companion file when publishing declarations.`,
      requiresReview: true,
    };
  }
}

export default { 'large-module': extractRecord };
