'use strict';

const path = require('node:path');
const { awaitedCall } = require('../workbook-decodes.cjs');
const {
  ts,
  calleeCall,
  enclosingStatement,
  freshName,
  indentationAt,
  lineStart,
  replaceNode,
} = require('./helpers.cjs');

const cacheType = "{ workbook?: import('exceljs').Workbook }";

function readerOf(call, owner) {
  if (
    !call ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.expression.kind !== ts.SyntaxKind.ThisKeyword
  )
    return;
  if (call.arguments.length !== 1 || !ts.isIdentifier(call.arguments[0]) || call.arguments.hasTrailingComma) return;
  const method = owner.members.find(
    (member) => ts.isMethodDeclaration(member) && member.name.text === call.expression.name.text,
  );
  if (
    !method?.body ||
    method.parameters.length !== 1 ||
    !method.modifiers?.some((item) => item.kind === ts.SyntaxKind.PrivateKeyword)
  )
    return;
  const parameter = method.parameters[0];
  if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken || parameter.questionToken)
    return;
  return method;
}

// A second private reader may run under a different catch. Store only a successfully loaded workbook.
function readerEdits(method, cacheName, text) {
  const block = method.body.statements.find(ts.isTryStatement)?.tryBlock ?? method.body;
  for (const [index, statement] of block.statements.entries()) {
    if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) continue;
    const declaration = statement.declarationList.declarations[0];
    const created = declaration.initializer;
    if (!created || !ts.isNewExpression(created) || created.arguments?.length || !ts.isIdentifier(declaration.name))
      continue;
    if (!ts.isPropertyAccessExpression(created.expression) || created.expression.name.text !== 'Workbook') continue;
    const namespace = created.expression.expression;
    const imported = block.statements[index - 1];
    if (
      !ts.isIdentifier(namespace) ||
      !imported ||
      !ts.isVariableStatement(imported) ||
      !(imported.declarationList.flags & ts.NodeFlags.Const)
    )
      continue;
    const binding = imported.declarationList.declarations[0];
    const awaited = binding.initializer;
    if (binding.name.text !== namespace.text || !awaited || !ts.isAwaitExpression(awaited)) continue;
    const dynamicImport = awaited.expression;
    if (
      !ts.isCallExpression(dynamicImport) ||
      dynamicImport.expression.kind !== ts.SyntaxKind.ImportKeyword ||
      dynamicImport.arguments[0]?.text !== 'exceljs'
    )
      continue;
    const name = declaration.name.text;
    const load = block.statements[index + 1];
    if (!load || !ts.isExpressionStatement(load) || !ts.isAwaitExpression(load.expression)) continue;
    const call = load.expression.expression;
    if (!ts.isCallExpression(call) || call.arguments.length !== 1 || call.expression.getText() !== name + '.xlsx.load')
      continue;
    const argument = ts.skipOuterExpressions(call.arguments[0]);
    if (
      !ts.isPropertyAccessExpression(argument) ||
      argument.name.text !== 'buffer' ||
      argument.expression.getText() !== method.parameters[0].name.text
    )
      continue;
    const sheets = new Set();
    const localObjects = new Set();
    function otherUse(node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer)
      )
        localObjects.add(node.name.text);
      if (
        ts.isBinaryExpression(node) &&
        ts.isAssignmentOperator(node.operatorToken.kind) &&
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
        !localObjects.has(node.left.expression.getText())
      )
        return true;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        /^(?:add|remove|splice|merge|unmerge|insert|duplicate|commit|destroy|protect|unprotect)/.test(
          node.expression.name.text,
        )
      )
        return true;
      if (ts.isIdentifier(node) && node.text === 'arguments') return true;
      if (
        ts.isIdentifier(node) &&
        node.text === name &&
        node !== declaration.name &&
        !(node.pos >= load.pos && node.end <= load.end)
      ) {
        const access = node.parent;
        if (!ts.isPropertyAccessExpression(access) || access.expression !== node || !ts.isCallExpression(access.parent))
          return true;
        if (access.name.text === 'getImage') return false;
        const sheet = access.parent.arguments[0];
        if (access.name.text !== 'getWorksheet' || !sheet || !ts.isStringLiteral(sheet)) return true;
        sheets.add(sheet.text.toLowerCase());
      }
      return ts.forEachChild(node, (child) => otherUse(child) || undefined);
    }
    if (otherUse(method.body) || !sheets.size) return;
    const parameter = method.parameters[0];
    const indent = indentationAt(text, load.getStart());
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const delimiter = text.slice(method.parameters.pos, parameter.getStart()).includes('\n')
      ? ',' + newline + indentationAt(text, parameter.getStart())
      : ', ';
    const edits = [
      { start: parameter.end, end: parameter.end, text: delimiter + cacheName + ': ' + cacheType + ' = {}' },
      replaceNode(created, cacheName + '.workbook ?? ' + created.getText()),
      replaceNode(
        load,
        [
          'if (!' + cacheName + '.workbook) {',
          indent + '  ' + load.getText(),
          indent + '  ' + cacheName + '.workbook = ' + name + ';',
          indent + '}',
        ].join(newline),
      ),
    ];
    return { sheets, edits };
  }
}

function shareWorkbook({ finding, node, sourceFile, text }) {
  if (!/\.[cm]?tsx?$/i.test(sourceFile.fileName)) return;
  const later = calleeCall(node);
  const related = finding.related?.[0];
  if (!later || !related || path.resolve(related.file) !== path.resolve(finding.file)) return;
  const offset = sourceFile.getPositionOfLineAndCharacter(related.line - 1, related.column - 1);
  const earlier = calleeCall(ts.getTokenAtPosition(sourceFile, offset));
  if (!earlier) return;
  const firstStatement = enclosingStatement(earlier);
  if (!firstStatement || firstStatement.parent !== enclosingStatement(later)?.parent) return;
  const owner = firstStatement.parent.parent.parent;
  if (!owner || !ts.isClassDeclaration(owner)) return;
  const readers = [readerOf(earlier, owner), readerOf(later, owner)];
  if (readers.some((reader) => !reader) || readers[0] === readers[1]) return;
  if (earlier.arguments[0].text !== later.arguments[0].text) return;
  const cacheName = freshName(sourceFile, 'workbookCache');
  if (!cacheName) return;
  const additions = readers.map((reader) => readerEdits(reader, cacheName, text));
  if (additions.some((addition) => !addition)) return;
  if ([...additions[0].sheets].some((sheet) => additions[1].sheets.has(sheet))) return;
  // Three overlapping pairs would each propose a new cache binding in this scope.
  for (const statement of firstStatement.parent.statements) {
    const call = awaitedCall(statement);
    if (!call || call === earlier || call === later || call.arguments[0]?.text !== earlier.arguments[0].text) continue;
    const reader = readerOf(call, owner);
    if (reader && readerEdits(reader, cacheName, text)) return;
  }
  const start = firstStatement.getStart();
  const indent = indentationAt(text, start);
  if (text.slice(lineStart(text, start), start) !== indent) return;
  return {
    edits: [
      {
        start,
        end: start,
        text: 'const ' + cacheName + ': ' + cacheType + ' = {};' + (text.includes('\r\n') ? '\r\n' : '\n') + indent,
      },
      ...[earlier, later].map((call) => ({
        start: call.arguments[0].end,
        end: call.arguments[0].end,
        text: ', ' + cacheName,
      })),
      ...additions.flatMap(({ edits }) => edits),
    ],
    separateEdits: true,
    requiresReview: true,
    note: 'One cache lives for this pair of reads. Check that the upload bytes stay unchanged and that both readers can share worksheet state. Each reader still retries a failed decode inside its existing error handler.',
  };
}

module.exports = { 'repeated-workbook-decode': shareWorkbook };
