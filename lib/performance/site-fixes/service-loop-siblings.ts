// Reusing a batch sibling that already exists: finds it beside the helper, or recognises the
// project's own array variant of the same write.
import { ts, nameTaken, textOf } from './helpers.js';
import { unwrap, simpleParameterNames, hasModifier } from './service-loop-ast.js';
import type { CallExpression, Expression, Node, ParameterDeclaration, SourceFile, Statement } from 'typescript';
import type { HelperFunction } from '../types/helper-function.js';
import type { SiblingDeclaration } from '../types/sibling-declaration.js';
import type { CalleeHelper } from '../types/callee-helper.js';
import type { WriteBatch } from '../types/batch-plan.js';

interface ParsedExpression {
  node?: Expression;
  sourceFile?: SourceFile;
}

/** The sibling the call site uses: one that exists, or the name of the one to add. */
interface BatchTarget {
  name: string;
  existing?: SiblingDeclaration;
}

// The declarations beside the helper: its class members, or the statements of the file holding a
// function.
function siblingDeclarations(declaration: HelperFunction): readonly SiblingDeclaration[] {
  if (ts.isClassLike(declaration.parent)) return declaration.parent.members;
  return ts.isSourceFile(declaration.parent) || ts.isModuleBlock(declaration.parent)
    ? declaration.parent.statements
    : [];
}

function declaredName(declaration: SiblingDeclaration): string | undefined {
  const name =
    ts.isClassElement(declaration) || ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)
      ? declaration.name
      : undefined;
  return name && ts.isIdentifier(name) ? name.text : undefined;
}

// Text compared line by line without indentation or line-ending differences, so a sibling an
// earlier fix inserted (possibly reformatted to the file's indentation) is recognised as this one.
function sameLines(declaration: Node, lines: readonly string[]): boolean {
  const normalized = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');
  return normalized(textOf(declaration)) === normalized(lines.join('\n'));
}

// A function in the file that takes exactly one parameter, so `list.map(fn)` passes it nothing
// extra that matters.
function unaryFunctionNamed(sourceFile: SourceFile, name: string): boolean {
  return sourceFile.statements.some(
    (statement: Statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === name &&
      statement.parameters.length === 1 &&
      !statement.parameters[0].dotDotDotToken,
  );
}

// A canonical form of an expression: parameters by position, arrow parameters by depth, `(x) =>
// fn(x)` as `fn` when `fn` is a one-parameter function of `sourceFile`, and no formatting. Two
// expressions with the same form do the same thing.
function canonical(node: Node, names: ReadonlyMap<string, string>, sourceFile: SourceFile, depth = 0): string {
  if (ts.isParenthesizedExpression(node)) return canonical(node.expression, names, sourceFile, depth);
  if (ts.isIdentifier(node)) {
    const parent = node.parent;
    const propertyName =
      parent && (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === node;
    return propertyName ? node.text : (names.get(node.text) ?? node.text);
  }
  if (ts.isArrowFunction(node) && node.parameters.length === 1 && ts.isIdentifier(node.parameters[0].name)) {
    const parameter = node.parameters[0].name.text;
    const body = ts.isParenthesizedExpression(node.body) ? node.body.expression : node.body;
    const forwards =
      ts.isCallExpression(body) &&
      ts.isIdentifier(body.expression) &&
      body.arguments.length === 1 &&
      ts.isIdentifier(body.arguments[0]) &&
      body.arguments[0].text === parameter &&
      unaryFunctionNamed(sourceFile, body.expression.text);
    if (forwards) return canonical(body.expression, names, sourceFile, depth);
    const inner = new Map(names).set(parameter, `$arrow${depth}`);
    return `(${inner.get(parameter)})=>${canonical(node.body, inner, sourceFile, depth + 1)}`;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return `#${node.getText()}`;
  const children: string[] = [];
  ts.forEachChild(node, (child) => {
    children.push(canonical(child, names, sourceFile, depth));
  });
  return children.length ? `${node.kind}(${children.join(',')})` : `${node.kind}:${node.getText()}`;
}

function parsedExpression(text: string, sourceFile: SourceFile): ParsedExpression {
  const parsed = ts.createSourceFile(sourceFile.fileName, `(${text});`, ts.ScriptTarget.Latest, true);
  const [statement] = parsed.statements;
  return statement && ts.isExpressionStatement(statement) ? { node: statement.expression, sourceFile: parsed } : {};
}

// `if (!list.length) return;` or `if (list.length === 0) return;`: nothing to write for an empty
// list.
function emptyListGuard(statement: Statement, listName: string): boolean {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
  const thenStatement =
    ts.isBlock(statement.thenStatement) && statement.thenStatement.statements.length === 1
      ? statement.thenStatement.statements[0]
      : statement.thenStatement;
  if (!ts.isReturnStatement(thenStatement) || thenStatement.expression) return false;
  const condition = textOf(statement.expression).replaceAll(/\s+/g, '');
  return [`!${listName}.length`, `${listName}.length===0`, `${listName}.length<1`].includes(condition);
}

// The project's own array variant of a write helper: the same parameters with the item one as a
// list, and a body that only skips an empty list and runs the same batch write the generated
// sibling would.
function equivalentWrite(
  member: SiblingDeclaration,
  callee: CalleeHelper,
  write: WriteBatch,
  itemIndex: number,
): boolean {
  const { declaration } = callee;
  if (
    member === declaration ||
    member.kind !== declaration.kind ||
    !(ts.isMethodDeclaration(member) || ts.isFunctionDeclaration(member)) ||
    !member.body ||
    !ts.isBlock(member.body) ||
    member.parameters.length !== declaration.parameters.length ||
    hasModifier(member, ts.SyntaxKind.StaticKeyword) !== hasModifier(declaration, ts.SyntaxKind.StaticKeyword)
  )
    return false;
  const memberParameterNames = simpleParameterNames(member);
  if (!memberParameterNames) return false;
  const sameParameters = declaration.parameters.every((parameter: ParameterDeclaration, index: number) => {
    const other = member.parameters[index];
    const typeText = (candidate: ParameterDeclaration) => (candidate.type ? textOf(candidate.type) : '');
    if (index !== itemIndex) return typeText(parameter) === typeText(other);
    if (!parameter.type || !other.type) return !parameter.type && !other.type;
    const item = textOf(parameter.type);
    return [`${item}[]`, `readonly ${item}[]`, `Array<${item}>`, `ReadonlyArray<${item}>`].includes(textOf(other.type));
  });
  if (!sameParameters) return false;
  const listName = memberParameterNames[itemIndex];
  const statements = member.body.statements.filter((statement: Statement) => !emptyListGuard(statement, listName));
  const [statement] = statements;
  if (statements.length !== 1 || !(ts.isExpressionStatement(statement) || ts.isReturnStatement(statement)))
    return false;
  const awaited = statement.expression && unwrap(statement.expression);
  if (!awaited || !ts.isAwaitExpression(awaited)) return false;
  const positions = (parameterNames: readonly string[], list: string) =>
    new Map(
      parameterNames.map((name, index): [string, string] => [name, index === itemIndex ? list : `$argument${index}`]),
    );
  const handler = write.handler ? `.catch(${textOf(write.handler)})` : '';
  const expected = parsedExpression(
    `${write.batchCall(listName, write.parameterNames[itemIndex])}${handler}`,
    declaration.getSourceFile(),
  );
  if (!expected.node) return false;
  const sourceFile = declaration.getSourceFile();
  const ownNames = positions(memberParameterNames, '$list');
  // The generated call names the list after the member's own parameter; the other parameters use
  // the helper's names.
  const expectedNames = new Map([...positions(write.parameterNames, '$item'), [listName, '$list']]);
  return canonical(awaited.expression, ownNames, sourceFile) === canonical(expected.node, expectedNames, sourceFile);
}

// The batch sibling to call: one already in the file (inserted by an earlier fix, or the project's
// own array variant of the same write), or a new `<helper>Many`. Undefined when that name already
// holds something different.
export function batchTarget(
  callee: CalleeHelper,
  lines: string[],
  write: WriteBatch | undefined,
  itemIndex: number,
): BatchTarget | undefined {
  const { declaration } = callee;
  const name = `${textOf(declaration.name)}Many`;
  const siblings = siblingDeclarations(declaration);
  const sameName = siblings.find((sibling) => declaredName(sibling) === name);
  if (sameName) {
    const reusable =
      sameLines(
        sameName,
        lines.map((line) => line.replace('BATCH_NAME', name)),
      ) ||
      (write && equivalentWrite(sameName, callee, write, itemIndex));
    return reusable ? { name, existing: sameName } : undefined;
  }
  const equivalent = write && siblings.find((sibling) => equivalentWrite(sibling, callee, write, itemIndex));
  const equivalentName = equivalent && declaredName(equivalent);
  if (equivalent && equivalentName) return { name: equivalentName, existing: equivalent };
  // A new function shares the file's scope; a new method only the class's members.
  if (ts.isFunctionDeclaration(declaration) && nameTaken(declaration.getSourceFile(), name)) return;
  return { name };
}

// A private or protected sibling can only be called from inside its own class.
export function callableFrom(existing: SiblingDeclaration, call: CallExpression): boolean {
  const hidden =
    hasModifier(existing, ts.SyntaxKind.PrivateKeyword) ||
    hasModifier(existing, ts.SyntaxKind.ProtectedKeyword) ||
    (ts.isClassElement(existing) && !!existing.name && ts.isPrivateIdentifier(existing.name));
  if (!hidden) return true;
  for (let current = call.parent; current; current = current.parent)
    if (ts.isClassLike(current)) return current === existing.parent;
  return false;
}
