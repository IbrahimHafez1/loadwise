'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

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

function selfContainedType(type, source) {
  if (scalars.has(type.kind)) return true;
  if (ts.isTypeLiteralNode(type)) return recordFields(type.members, source);
  if (ts.isArrayTypeNode(type)) return selfContainedType(type.elementType, source);
  if (ts.isUnionTypeNode(type)) return type.types.every((member) => selfContainedType(member, source));
  if (ts.isLiteralTypeNode(type))
    return type.literal.kind === ts.SyntaxKind.NullKeyword || ts.isStringLiteral(type.literal);
  if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName) || source.locals.has(type.typeName.escapedText))
    return false;
  if (type.typeName.text === 'Date') return !type.typeArguments;
  return (
    ['Array', 'ReadonlyArray'].includes(type.typeName.text) &&
    type.typeArguments?.length === 1 &&
    selfContainedType(type.typeArguments[0], source)
  );
}

function recordFields(members, source) {
  return members.every(
    (member) =>
      ts.isPropertySignature(member) &&
      ts.isIdentifier(member.name) &&
      member.type &&
      selfContainedType(member.type, source),
  );
}

function extractRecord({ sourceFile, text, finding }) {
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
    if (
      (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) ||
      statement.modifiers?.length ||
      statement.typeParameters ||
      statement.heritageClauses
    )
      continue;
    const name = statement.name;
    if (sourceFile.locals.get(name.escapedText)?.declarations?.length !== 1) continue;
    const members = ts.isInterfaceDeclaration(statement)
      ? statement.members
      : ts.isTypeLiteralNode(statement.type) && statement.type.members;
    if (!members || !recordFields(members, sourceFile)) continue;
    const before = statement.getText(sourceFile);
    const count = before.split('\n').length;
    if (count < minimumRecordLines || count > maximumRecordLines) continue;
    const start = statement.getStart(sourceFile);
    const previousLine = text.lastIndexOf('\n', start - 1) + 1;
    if (previousLine !== start || !/^(?:\r?\n|$)/.test(text.slice(statement.end))) continue;
    // Comments with directives or documentation links can refer to the original module.
    if (/\/\/|\/\*/.test(statement.getFullText(sourceFile))) continue;
    const file = path.posix.join(path.posix.dirname(finding.file.replaceAll('\\', '/')), stem + '.ts');
    return {
      edits: [{ start, end: statement.end, text: `import type { ${name.text} } from './${stem}.js';` }],
      createdType: { file, text: 'export ' + before + (text.includes('\r\n') ? '\r\n' : '\n') },
      note: `Moves the ${count}-line private record into a sibling type module. Verify your build includes the companion file when publishing declarations.`,
      requiresReview: true,
    };
  }
}

module.exports = { 'large-module': extractRecord };
