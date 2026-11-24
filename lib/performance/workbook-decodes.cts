import { loadSyntax } from './compiler.cjs';
import { calleeName, relativeFile, resolvedSymbol } from './schema/ts-helpers.cjs';
import type {
  Block,
  CallExpression,
  Expression,
  FunctionDeclaration,
  Identifier,
  MethodDeclaration,
  Node,
  SourceFile,
  Statement,
} from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext } from '../shared/types.cjs';
const ts = loadSyntax();

/** What an ExcelJS `load` decodes: a binding, or the upload buffer of that binding. */
interface WorkbookInput {
  binding: Identifier;
  buffer: boolean;
}

/** A function whose only parameter feeds a workbook decode, so calls of it decode that argument. */
interface DecoderHelper {
  owner: FunctionDeclaration | MethodDeclaration;
  name: string;
  buffer: boolean;
}

interface EarlierDecode {
  buffer: boolean;
  call: CallExpression;
}

// Restrict the comparison to ordinary sibling awaits on a binding or its upload buffer.
function inputOf(expression: Expression): WorkbookInput | undefined {
  const input = ts.skipOuterExpressions(expression);
  if (ts.isIdentifier(input)) return { binding: input, buffer: false };
  if (ts.isPropertyAccessExpression(input) && input.name.text === 'buffer' && ts.isIdentifier(input.expression))
    return { binding: input.expression, buffer: true };
}

function awaitedCall(statement: Statement): CallExpression | undefined {
  let value: Expression | undefined;
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

function afterDeclarations(statement: Statement): boolean {
  const block = statement.parent;
  return (
    ts.isBlock(block) && block.statements.slice(0, block.statements.indexOf(statement)).every(ts.isVariableStatement)
  );
}

function usesInputElsewhere(node: Node, binding: Identifier): boolean {
  if (ts.isIdentifier(node)) return node !== binding && node.text === binding.text;
  return ts.forEachChild(node, (child) => usesInputElsewhere(child, binding) || undefined) === true;
}

function decoderParameter(
  call: CallExpression,
  input: WorkbookInput,
  checker: CheckerAdapter,
): DecoderHelper | undefined {
  const statement = call.parent.parent;
  if (!ts.isExpressionStatement(statement) || awaitedCall(statement) !== call || !afterDeclarations(statement)) return;
  let block = statement.parent;
  // A common import helper catches malformed spreadsheets around the actual decoding.
  if (ts.isTryStatement(block.parent) && block.parent.tryBlock === block) {
    if (!afterDeclarations(block.parent)) return;
    block = block.parent.parent;
  }
  const owner = block.parent;
  if (
    !ts.isFunctionDeclaration(owner) &&
    !(
      ts.isMethodDeclaration(owner) &&
      owner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)
    )
  )
    return;
  const { name } = owner;
  if (owner.body !== block || !name || ts.isComputedPropertyName(name)) return;
  if (owner.parameters.length !== 1 || resolvedSymbol(input.binding, checker)?.valueDeclaration !== owner.parameters[0])
    return;
  if (usesInputElsewhere(block, input.binding)) return;
  return { owner, name: name.text, buffer: input.buffer };
}

function forgetUsedInputs(node: Node, previous: Map<string, EarlierDecode>): void {
  if (!previous.size) return;
  if (ts.isIdentifier(node)) previous.delete(node.text);
  else ts.forEachChild(node, (child) => forgetUsedInputs(child, previous));
}

function checkWorkbookDecodes(sourceFile: SourceFile, context: PerformanceRuleContext): void {
  if (!sourceFile.text.includes('xlsx') || !sourceFile.text.includes('load')) return;
  const direct = new Map<CallExpression, WorkbookInput>();
  const helpers = new Map<Node, DecoderHelper | undefined>();
  const helperNames = new Set<string>();
  const blocks: Block[] = [];

  function visit(node: Node): void {
    if (ts.isBlock(node) && node.statements.length >= 2) blocks.push(node);
    if (ts.isCallExpression(node) && node.arguments.length === 1 && calleeName(node) === 'load') {
      const callee = node.expression;
      const xlsx =
        ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? callee.expression : undefined;
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

  function comparisonInput(call: CallExpression): WorkbookInput | undefined {
    const known = direct.get(call);
    if (known) return known;
    const name = calleeName(call);
    if (call.arguments.length !== 1 || name === undefined || !helperNames.has(name)) return;
    const declaration = resolvedSymbol(call.expression, context.checker)?.valueDeclaration;
    const helper = declaration && helpers.get(declaration);
    if (!helper) return;
    const input = inputOf(call.arguments[0]);
    if (input && !(input.buffer && helper.buffer))
      return { binding: input.binding, buffer: input.buffer || helper.buffer };
  }

  visit(sourceFile);
  if (!direct.size) return;
  for (const block of blocks) {
    const previous = new Map<string, EarlierDecode>();
    for (const statement of block.statements) {
      const call = awaitedCall(statement);
      const input = call && comparisonInput(call);
      if (!input && !previous.size) continue;
      const earlier = input && previous.get(input.binding.text);
      if (call && input && earlier && earlier.buffer === input.buffer) {
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
      // An intervening use may reassign the input, modify its bytes or pass them to another
      // operation.
      forgetUsedInputs(statement, previous);
      if (call && input) previous.set(input.binding.text, { buffer: input.buffer, call });
    }
  }
}

function recordDecoderParameter(
  parameter: DecoderHelper | undefined,
  helperNames: Set<string>,
  helpers: Map<Node, DecoderHelper | undefined>,
): void {
  if (parameter) {
    helperNames.add(parameter.name);
    // Different or multiple loads in the same helper do not identify a unique forwarded input.
    helpers.set(parameter.owner, helpers.has(parameter.owner) ? undefined : parameter);
  }
}

export { checkWorkbookDecodes, awaitedCall };
