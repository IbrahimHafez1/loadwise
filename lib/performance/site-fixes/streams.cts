import { ts, enclosingStatement, indentationAt, nameTaken, textOf } from './helpers.cjs';
import type {
  Node,
  ParameterDeclaration,
  SignatureDeclaration,
  SourceFile,
  Statement,
  VariableDeclaration,
} from 'typescript';
import type { MethodCall } from '../types/method-call.cjs';
import type { FixResult, SiteFixInput, TextEdit } from '../../shared/types.cjs';

const STREAM_PROMISES = new Set(['node:stream/promises', 'stream/promises']);
const NUMBER_PARSERS = new Set(['Number', 'parseInt', 'Number.parseInt']);
const REQUEST_MEMBERS = new Set(['query', 'params', 'body']);
const pipelineNote =
  '`await pipeline(...)` destroys every stream when one fails and rejects with the error, so the caller now waits for the copy to finish and must handle that rejection. Check that nothing after this line expected the copy to keep running in the background.';
const numberNote =
  'Invalid input now gets a 400 response before it is used. Add the range this value may take (for example a maximum page size) to the same check.';

function isAsyncFunction(fn: SignatureDeclaration | undefined): boolean {
  if (!fn || !ts.canHaveModifiers(fn)) return false;
  const isGenerator = 'asteriskToken' in fn && fn.asteriskToken;
  return !!ts.getModifiers(fn)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) && !isGenerator;
}

function isPipeCall(node: Node): node is MethodCall {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'pipe' &&
    node.arguments.length === 1
  );
}

function pipeChain(call: MethodCall): Node[] {
  const streams: Node[] = [];
  let current: Node = call;
  while (isPipeCall(current)) {
    streams.unshift(current.arguments[0]);
    current = ts.skipOuterExpressions(current.expression.expression);
  }
  streams.unshift(current);
  return streams;
}

function importsPipeline(statement: Statement): boolean {
  if (ts.isImportDeclaration(statement)) {
    const bindings = statement.importClause?.namedBindings;
    return (
      ts.isStringLiteral(statement.moduleSpecifier) &&
      STREAM_PROMISES.has(statement.moduleSpecifier.text) &&
      !!bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((element) => element.name.text === 'pipeline')
    );
  }
  if (!ts.isVariableStatement(statement)) return false;
  return statement.declarationList.declarations.some((declaration: VariableDeclaration) => {
    const initializer = declaration.initializer && ts.skipOuterExpressions(declaration.initializer);
    const isRequire =
      initializer &&
      ts.isCallExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      initializer.expression.text === 'require' &&
      initializer.arguments[0] &&
      ts.isStringLiteralLike(initializer.arguments[0]) &&
      STREAM_PROMISES.has(initializer.arguments[0].text);
    return (
      isRequire &&
      ts.isObjectBindingPattern(declaration.name) &&
      declaration.name.elements.some((element) => ts.isIdentifier(element.name) && element.name.text === 'pipeline')
    );
  });
}

function isRequireStatement(statement: Statement): boolean {
  return ts.isVariableStatement(statement) && /^\s*(?:const|let|var)\s[^=]+=\s*require\(/.test(textOf(statement));
}

function isCommonJs(sourceFile: SourceFile): boolean {
  if (/\.c[jt]s$/.test(sourceFile.fileName)) return true;
  if (!sourceFile.fileName.endsWith('.js')) return false;
  return !sourceFile.statements.some(ts.isImportDeclaration) && sourceFile.statements.some(isRequireStatement);
}

// Adds the pipeline import after the file's last import or require, or after its directives.
function pipelineImport(sourceFile: SourceFile): TextEdit {
  const commonJs = isCommonJs(sourceFile);
  const line = commonJs
    ? "const { pipeline } = require('node:stream/promises');"
    : "import { pipeline } from 'node:stream/promises';";
  const isImport = commonJs ? isRequireStatement : ts.isImportDeclaration;
  const statements = sourceFile.statements;
  let anchor = statements.filter(isImport).at(-1);
  if (!anchor) {
    for (const statement of statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
      anchor = statement;
    }
  }
  if (!anchor) return { start: 0, end: 0, text: line + '\n' };
  return { start: anchor.end, end: anchor.end, text: '\n' + line };
}

function pipelineFix({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const statement = enclosingStatement(node);
  if (!statement || !ts.isExpressionStatement(statement)) return;
  const call = ts.skipOuterExpressions(statement.expression);
  if (!isPipeCall(call) || call.getStart() !== node.getStart()) return;
  if (!isAsyncFunction(ts.findAncestor(statement.parent, ts.isFunctionLike))) return;
  const streams = pipeChain(call).map(textOf);
  const edits: TextEdit[] = [
    { start: statement.getStart(), end: statement.end, text: `await pipeline(${streams.join(', ')});` },
  ];
  if (!sourceFile.statements.some(importsPipeline)) {
    if (nameTaken(sourceFile, 'pipeline')) return;
    edits.push(pipelineImport(sourceFile));
  }
  return { edits, requiresReview: true, note: pipelineNote, separateEdits: true };
}

function responseParameter(fn: SignatureDeclaration): ParameterDeclaration | undefined {
  return fn.parameters.find(
    (parameter: ParameterDeclaration) => ts.isIdentifier(parameter.name) && parameter.name.text === 'res',
  );
}

// `const page = Number(req.query.page);` -> a 400 guard right after the declaration.
function numberGuardFix({ node, text }: SiteFixInput): FixResult | undefined {
  if (!node || text === undefined) return;
  const call = ts.findAncestor(node, ts.isCallExpression);
  if (!call || call.getStart() !== node.getStart()) return;
  if (!NUMBER_PARSERS.has(textOf(call.expression))) return;
  const declaration = call.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return;
  const declarationList = declaration.parent;
  if (!ts.isVariableDeclarationList(declarationList)) return;
  const statement = declarationList.parent;
  if (!ts.isVariableStatement(statement) || declarationList.declarations.length !== 1) return;
  const handler = statement.parent?.parent;
  if (!ts.isBlock(statement.parent) || !handler || !ts.isFunctionLike(handler) || !responseParameter(handler)) return;
  const input = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  const isRequestField =
    input &&
    ts.isPropertyAccessExpression(input) &&
    ts.isPropertyAccessExpression(input.expression) &&
    REQUEST_MEMBERS.has(input.expression.name.text) &&
    ts.isIdentifier(input.expression.expression);
  if (!isRequestField) return;
  const name = declaration.name.text;
  const guard = `if (!Number.isFinite(${name})) return res.status(400).json({ error: 'Invalid ${input.name.text}' });`;
  const indentation = indentationAt(text, statement.getStart());
  return {
    edits: [{ start: statement.end, end: statement.end, text: `\n${indentation}${guard}` }],
    requiresReview: true,
    note: numberNote,
  };
}

export default {
  'stream-pipe-unhandled-error': pipelineFix,
  'request-number-unvalidated': numberGuardFix,
};
