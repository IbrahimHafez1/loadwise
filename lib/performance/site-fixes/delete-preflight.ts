import { ts, enclosingStatement, freshName, replaceNode } from './helpers.js';
import { preflightDigest } from '../drizzle-write-preflight.js';
import path from 'node:path';
import type { Node, SourceFile } from 'typescript';
import type { FixResult, SiteFixInput } from '../../shared/types.js';

// A conventional service test can supply a void-returning DELETE even with mysql2 installed.
// Keep the read-dependent error contract visible until that mock supplies an affected-row count.
function incompatibleDeleteMock(sourceFile: SourceFile, load: SiteFixInput['load']): boolean {
  const file = path.parse(sourceFile.fileName);
  function missingHeader(call: Node): boolean {
    if (!ts.isCallExpression(call)) return false;
    const method = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
    if (!ts.isIdentifier(method) || !/^mock(?:Resolved|Return)Value(?:Once)?$/.test(method.text)) return false;
    const value = call.arguments[0];
    if (!value || value.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(value) && value.text === 'undefined'))
      return true;
    if (ts.isObjectLiteralExpression(value)) return true;
    if (!ts.isArrayLiteralExpression(value)) return false;
    const header = value.elements[0];
    return (
      !header ||
      (ts.isObjectLiteralExpression(header) &&
        header.properties.every(
          (property) =>
            ts.isPropertyAssignment(property) &&
            !ts.isComputedPropertyName(property.name) &&
            property.name.text !== 'affectedRows',
        ))
    );
  }
  function voidWhere(node: Node): boolean | undefined {
    return (
      (ts.isPropertyAssignment(node) &&
        !ts.isComputedPropertyName(node.name) &&
        node.name.text === 'where' &&
        missingHeader(node.initializer)) ||
      ts.forEachChild(node, voidWhere)
    );
  }
  function visit(node: Node): boolean | undefined {
    return (
      (ts.isPropertyAssignment(node) &&
        !ts.isComputedPropertyName(node.name) &&
        node.name.text === 'delete' &&
        voidWhere(node.initializer)) ||
      ts.forEachChild(node, visit)
    );
  }
  for (const suffix of ['spec', 'test']) {
    const filename = file.name + '.' + suffix + file.ext;
    for (const directory of [file.dir, path.join(file.dir, '__tests__')]) {
      const companion = load(path.join(directory, filename));
      if (companion?.sourceFile && visit(companion.sourceFile)) return true;
    }
  }
  return false;
}

function deletePreflight({ finding, node, sourceFile, text, load }: SiteFixInput): FixResult | undefined {
  if (!finding.mysql2DeletePreflight || !node || !sourceFile || text === undefined) return;
  if (incompatibleDeleteMock(sourceFile, load)) return;
  const read = enclosingStatement(node);
  if (!read || !ts.isVariableStatement(read) || !(read.declarationList.flags & ts.NodeFlags.Const)) return;
  const declaration = read.declarationList.declarations[0];
  if (declaration.type || !ts.isArrayBindingPattern(declaration.name)) return;
  if (!ts.isBlock(read.parent) && !ts.isSourceFile(read.parent)) return;
  const siblings = read.parent.statements;
  const position = siblings.indexOf(read);
  const guard = siblings[position + 1];
  const write = siblings[position + 2];
  if (!guard || !ts.isIfStatement(guard) || !write || preflightDigest(read, write) !== finding.mysql2DeletePreflight)
    return;
  const [firstElement] = declaration.name.elements;
  if (!ts.isBindingElement(firstElement) || !ts.isIdentifier(firstElement.name)) return;
  const binding = firstElement.name.text;
  function usesReadBinding(node: Node): boolean | undefined {
    return (ts.isIdentifier(node) && node.text === binding) || ts.forEachChild(node, usesReadBinding);
  }
  // Earlier closures can capture the result even if they only run after the DELETE.
  if (siblings.slice(0, position).some(usesReadBinding)) return;
  const comments = /\/\/|\/\*/;
  const writeLineEnd = text.indexOf('\n', write.end);
  if (
    comments.test(text.slice(read.pos, guard.expression.end)) ||
    comments.test(text.slice(guard.end, writeLineEnd < 0 ? text.length : writeLineEnd))
  )
    return;
  const result = freshName(sourceFile, 'deleteResult');
  if (!result) return;
  return {
    edits: [
      replaceNode(read, `const [${result}] = ${write.getText(sourceFile)}`),
      replaceNode(guard.expression, `${result}.affectedRows === 0`),
      { start: guard.end, end: write.end, text: '' },
    ],
    requiresReview: true,
    note: 'The MySQL DELETE decides whether the row existed. A competing delete now triggers the existing missing-row error. Check concurrency expectations and ensure wrappers and tests return the mysql2 result tuple with affectedRows.',
  };
}

export default { 'drizzle-write-preflight': deletePreflight };
