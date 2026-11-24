// Write-batch planning: turns a helper that is one insert into a sibling that writes a whole list
// in one statement.
import { ts, indentationAt, textOf } from './helpers.cjs';
import { isMethodCall } from './method-calls.cjs';
import { unwrap, references, simpleParameterNames, objectProperty, queryCall } from './service-loop-ast.cjs';
import { signatureText } from './service-loop-signature.cjs';
import type { Expression, Node, Statement } from 'typescript';
import type { MethodCall } from '../types/method-call.cjs';
import type { ClientFamily } from '../types/client-family.cjs';
import type { CalleeHelper } from '../types/callee-helper.cjs';
import type { WriteBatch } from '../types/batch-plan.cjs';

// `await repo.save(repo.create(X))`, `await repo.insert(X)`, `await prisma.model.create({ data: X
// })`, or
// `const row = repo.create(X); await repo.save(row);` as the whole body.
export function writeBatch(callee: CalleeHelper, family: ClientFamily, typed: boolean): WriteBatch | undefined {
  const { declaration } = callee;
  const parameterNames = simpleParameterNames(declaration);
  if (!ts.isBlock(declaration.body) || !parameterNames) return;
  const statements = declaration.body.statements;
  const last = statements[statements.length - 1];
  if (!last || statements.length > 2) return;
  const lastExpression = ts.isExpressionStatement(last) || ts.isReturnStatement(last) ? last.expression : undefined;
  let call = lastExpression && queryCall(lastExpression);
  let handler: Expression | undefined;
  if (call && call.expression.name.text === 'catch' && call.arguments.length === 1) {
    handler = call.arguments[0];
    call = queryCall(call.expression.expression);
  }
  if (!call || call.arguments.length !== 1) return;
  const method = call.expression.name.text;
  const receiver = textOf(call.expression.expression);
  let item: Expression;
  let batchCall: (list: string, parameter: string) => string;
  if (family === 'prisma' && method === 'create' && statements.length === 1) {
    const options = unwrap(call.arguments[0]);
    const data =
      ts.isObjectLiteralExpression(options) && options.properties.length === 1 && objectProperty(options, 'data');
    if (!data || !ts.isPropertyAssignment(data)) return;
    item = data.initializer;
    const dataItem = item;
    batchCall = (list, parameter) =>
      `${receiver}.createMany({ data: ${list}.map((${parameter}) => ${wrapped(dataItem)}) })`;
  } else if (family === 'typeorm' && method === 'insert' && statements.length === 1) {
    item = call.arguments[0];
    const insertedItem = item;
    batchCall = (list, parameter) => `${receiver}.insert(${list}.map((${parameter}) => ${wrapped(insertedItem)}))`;
  } else if (family === 'typeorm' && method === 'save') {
    const created = createdEntity(statements, call, receiver);
    if (!created) return;
    item = created;
    batchCall = (list, parameter) =>
      `${receiver}.save(${list}.map((${parameter}) => ${receiver}.create(${textOf(created)})))`;
  } else return;
  const used = parameterNames.filter((name) => references(item, new Set([name])));
  if (!used.length || parameterNames.some((name) => handler && references(handler, new Set([name])))) return;
  return { kind: 'write', receiver, parameterNames, batchCall, handler, used, typed };
}

function wrapped(node: Expression): string {
  return ts.isObjectLiteralExpression(unwrap(node)) ? `(${textOf(node)})` : textOf(node);
}

// The X of `repo.save(repo.create(X))`, or of `const row = repo.create(X); await repo.save(row);`.
function createdEntity(
  statements: readonly Statement[],
  saveCall: MethodCall,
  receiver: string,
): Expression | undefined {
  const argument = unwrap(saveCall.arguments[0]);
  const isCreate = (node: Node): node is MethodCall =>
    isMethodCall(node) &&
    node.expression.name.text === 'create' &&
    textOf(node.expression.expression) === receiver &&
    node.arguments.length === 1;
  if (statements.length === 1) return isCreate(argument) ? argument.arguments[0] : undefined;
  const [first] = statements;
  if (!ts.isVariableStatement(first) || first.declarationList.declarations.length !== 1) return;
  const declaration = first.declarationList.declarations[0];
  const initializer = declaration.initializer && unwrap(declaration.initializer);
  if (!ts.isIdentifier(declaration.name) || !ts.isIdentifier(argument) || argument.text !== declaration.name.text)
    return;
  return initializer && isCreate(initializer) ? initializer.arguments[0] : undefined;
}

export function writeLines(callee: CalleeHelper, write: WriteBatch, itemIndex: number, listName: string): string[] {
  const { declaration } = callee;
  const sourceFile = declaration.getSourceFile();
  const indentation = indentationAt(sourceFile.text, declaration.getStart(sourceFile));
  const bodyIndentation = indentationAt(sourceFile.text, declaration.body.statements[0].getStart(sourceFile));
  const parameter = write.parameterNames[itemIndex];
  const handler = write.handler ? `.catch(${textOf(write.handler)})` : '';
  return [
    `${indentation}${signatureText({ declaration, batchName: 'BATCH_NAME', itemIndex, listName, typed: write.typed, returnType: 'void' })}`,
    `${bodyIndentation}if (!${listName}.length) return;`,
    `${bodyIndentation}await ${write.batchCall(listName, parameter)}${handler};`,
    `${indentation}}`,
  ];
}
