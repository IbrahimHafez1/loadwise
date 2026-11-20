'use strict';

const {
  ts,
  textOf,
  calleeCall,
  enclosingStatement,
  freshName,
  indentationAt,
  isPlainReference,
} = require('./helpers.cjs');

const SCAN_BATCH_SIZE = 100;

// `const keys = await redis.keys(pattern)` as { declaration, call }; other shapes stay manual.
function awaitedKeysDeclaration(statement) {
  if (!statement || !ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return;
  const [declaration] = statement.declarationList.declarations;
  const awaited = declaration.initializer;
  if (!ts.isIdentifier(declaration.name) || declaration.type || !awaited || !ts.isAwaitExpression(awaited)) return;
  const call = awaited.expression;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return;
  if (call.expression.name.text.toLowerCase() !== 'keys' || call.arguments.length !== 1) return;
  if (!isPlainReference(call.expression.expression) || ts.isSpreadElement(call.arguments[0])) return;
  return { declaration, call };
}

function redisKeysFix({ finding, node, sourceFile }) {
  const statement = enclosingStatement(node);
  const found = awaitedKeysDeclaration(statement);
  if (!found || found.call !== calleeCall(node)) return;
  const { declaration, call } = found;
  const client = textOf(call.expression.expression);
  const pattern = textOf(call.arguments[0]);
  const keys = declaration.name.text;
  const indentation = indentationAt(sourceFile.text, statement.getStart());
  const keyword = declaration.parent.flags & ts.NodeFlags.Const ? 'const' : 'let';
  const typed = /\.[cm]?tsx?$/.test(sourceFile.fileName) ? ': string[]' : '';
  let loop;
  if (finding.message.includes('.scanStream(')) {
    const batch = freshName(sourceFile, 'batch');
    loop = `for await (const ${batch} of ${client}.scanStream({ match: ${pattern}, count: ${SCAN_BATCH_SIZE} })) ${keys}.push(...${batch});`;
  } else if (finding.message.includes('(yields one key per step)')) {
    const key = freshName(sourceFile, 'key');
    loop = `for await (const ${key} of ${client}.scanIterator({ MATCH: ${pattern}, COUNT: ${SCAN_BATCH_SIZE} })) ${keys}.push(${key});`;
  } else return;
  return {
    edits: [
      {
        start: statement.getStart(),
        end: statement.end,
        text: `${keyword} ${keys}${typed} = [];\n${indentation}${loop}`,
      },
    ],
  };
}

module.exports = { 'redis-keys-command': redisKeysFix };
