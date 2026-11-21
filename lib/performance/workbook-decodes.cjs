'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { calleeName, relativeFile, resolvedSymbol } = require('./schema/ts-helpers.cjs');

// Restrict the comparison to ordinary sibling awaits on a binding or its upload buffer.
function inputOf(expression) {
  const input = ts.skipOuterExpressions(expression);
  if (ts.isIdentifier(input)) return { binding: input, buffer: false };
  if (ts.isPropertyAccessExpression(input) && input.name.text === 'buffer' && ts.isIdentifier(input.expression))
    return { binding: input.expression, buffer: true };
}

function awaitedCall(statement) {
  let value;
  if (ts.isExpressionStatement(statement)) value = statement.expression;
  else if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1)
    value = statement.declarationList.declarations[0].initializer;
  if (
    value &&
    ts.isAwaitExpression(value) &&
    ts.isCallExpression(value.expression) &&
    !ts.isOptionalChain(value.expression)
  )
    return value.expression;
}

function afterDeclarations(statement) {
  const block = statement.parent;
  return (
    ts.isBlock(block) && block.statements.slice(0, block.statements.indexOf(statement)).every(ts.isVariableStatement)
  );
}

function usesInputElsewhere(node, binding) {
  if (ts.isIdentifier(node)) return node !== binding && node.text === binding.text;
  return ts.forEachChild(node, (child) => usesInputElsewhere(child, binding) || undefined);
}

function decoderParameter(call, input, checker) {
  const statement = call.parent.parent;
  if (!ts.isExpressionStatement(statement) || awaitedCall(statement) !== call || !afterDeclarations(statement)) return;
  let block = statement.parent;
  // A common import helper catches malformed spreadsheets around the actual decoding.
  if (ts.isTryStatement(block.parent) && block.parent.tryBlock === block) {
    if (!afterDeclarations(block.parent)) return;
    block = block.parent.parent;
  }
  const owner = block.parent;
  if (owner.body !== block || !owner.name) return;
  if (
    !ts.isFunctionDeclaration(owner) &&
    !(
      ts.isMethodDeclaration(owner) &&
      owner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)
    )
  )
    return;
  if (owner.parameters.length !== 1 || resolvedSymbol(input.binding, checker)?.valueDeclaration !== owner.parameters[0])
    return;
  if (usesInputElsewhere(block, input.binding)) return;
  return { owner, buffer: input.buffer };
}

function forgetUsedInputs(node, previous) {
  if (!previous.size) return;
  if (ts.isIdentifier(node)) previous.delete(node.text);
  else ts.forEachChild(node, (child) => forgetUsedInputs(child, previous));
}

function checkWorkbookDecodes(sourceFile, context) {
  if (!sourceFile.text.includes('xlsx') || !sourceFile.text.includes('load')) return;
  const direct = new Map();
  const helpers = new Map();
  const helperNames = new Set();
  const blocks = [];

  function visit(node) {
    if (ts.isBlock(node) && node.statements.length >= 2) blocks.push(node);
    if (ts.isCallExpression(node) && node.arguments.length === 1 && calleeName(node) === 'load') {
      const xlsx = node.expression.expression;
      if (
        xlsx &&
        ts.isPropertyAccessExpression(xlsx) &&
        xlsx.name.text === 'xlsx' &&
        context.isPackageType(xlsx.expression, ['exceljs'], ['Workbook'])
      ) {
        const input = inputOf(node.arguments[0]);
        if (input) {
          direct.set(node, input);
          const parameter = decoderParameter(node, input, context.checker);
          recordDecoderParameter(parameter, helperNames, helpers);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  function comparisonInput(call) {
    if (direct.has(call)) return direct.get(call);
    if (call.arguments.length !== 1 || !helperNames.has(calleeName(call))) return;
    const helper = helpers.get(resolvedSymbol(call.expression, context.checker)?.valueDeclaration);
    if (!helper) return;
    const input = inputOf(call.arguments[0]);
    if (input && !(input.buffer && helper.buffer))
      return { binding: input.binding, buffer: input.buffer || helper.buffer };
  }

  visit(sourceFile);
  if (!direct.size) return;
  for (const block of blocks) {
    const previous = new Map();
    for (const statement of block.statements) {
      const call = awaitedCall(statement);
      const input = call && comparisonInput(call);
      if (!input && !previous.size) continue;
      const earlier = input && previous.get(input.binding.text);
      if (earlier && earlier.buffer === input.buffer) {
        const key = input.binding.text + (input.buffer ? '.buffer' : '');
        const position = sourceFile.getLineAndCharacterOfPosition(earlier.call.getStart(sourceFile));
        context.report(
          call,
          'repeated-workbook-decode',
          `This workflow passes \`${key}\` to ExcelJS workbook decoding more than once. Reuse a decoded workbook for read-only sheet processing when the input bytes stay unchanged and the readers can share workbook state.`,
          undefined,
          {
            related: [
              {
                file: relativeFile(sourceFile.fileName),
                line: position.line + 1,
                column: position.character + 1,
                message: 'Earlier decode of the same input.',
              },
            ],
          },
        );
      }
      // An intervening use may reassign the input, modify its bytes or pass them to another operation.
      forgetUsedInputs(statement, previous);
      if (input) previous.set(input.binding.text, { buffer: input.buffer, call });
    }
  }
}

function recordDecoderParameter(parameter, helperNames, helpers) {
  if (parameter) {
    helperNames.add(parameter.owner.name.text);
    // Different or multiple loads in the same helper do not identify a unique forwarded input.
    helpers.set(parameter.owner, helpers.has(parameter.owner) ? undefined : parameter);
  }
}

module.exports = { checkWorkbookDecodes, awaitedCall };
