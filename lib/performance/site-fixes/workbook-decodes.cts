import path from 'node:path';
import { awaitedCall } from '../workbook-decodes.cjs';
import { ts, calleeCall, enclosingStatement, freshName, indentationAt, lineStart, replaceNode } from './helpers.cjs';
import type { Block, CallExpression, ClassDeclaration, MethodDeclaration, Node, SourceFile } from 'typescript';
import type { RelatedLocation } from '../types/related-location.cjs';
import type { Finding, FixResult, SiteFixInput, TextEdit } from '../../shared/types.cjs';

/** The edits that make one reader take the shared cache, and the worksheets it reads by name. */
interface ReaderEdits {
  sheets: Set<string>;
  edits: TextEdit[];
}

const cacheType = "{ workbook?: import('exceljs').Workbook }";

function readerOf(call: CallExpression | undefined, owner: ClassDeclaration): MethodDeclaration | undefined {
  if (
    !call ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.expression.kind !== ts.SyntaxKind.ThisKeyword
  )
    return;
  if (call.arguments.length !== 1 || !ts.isIdentifier(call.arguments[0]) || call.arguments.hasTrailingComma) return;
  const calledName = call.expression.name.text;
  const method = owner.members.find(
    (member): member is MethodDeclaration =>
      ts.isMethodDeclaration(member) && !ts.isComputedPropertyName(member.name) && member.name.text === calledName,
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

// A second private reader may run under a different catch. Store only a successfully loaded
// workbook.
// loadwise-reviewed high-branch-complexity -- a pattern match on a fixed statement sequence (dynamic import, new Workbook, load) where each continue rejects one non-matching shape; splitting scatters one pattern
function readerEdits(method: MethodDeclaration, cacheName: string, text: string): ReaderEdits | undefined {
  const body = method.body;
  if (!body) return;
  const block = body.statements.find(ts.isTryStatement)?.tryBlock ?? body;
  const parameter = method.parameters[0];
  const parameterName = ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
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
    if (
      !ts.isIdentifier(binding.name) ||
      binding.name.text !== namespace.text ||
      !awaited ||
      !ts.isAwaitExpression(awaited)
    )
      continue;
    const dynamicImport = awaited.expression;
    if (!ts.isCallExpression(dynamicImport) || dynamicImport.expression.kind !== ts.SyntaxKind.ImportKeyword) continue;
    const importedModule = dynamicImport.arguments[0];
    if (!importedModule || !ts.isStringLiteralLike(importedModule) || importedModule.text !== 'exceljs') continue;
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
      argument.expression.getText() !== parameterName
    )
      continue;
    const sheets = new Set<string>();
    const localObjects = new Set<string>();
    function otherUse(node: Node): boolean | undefined {
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
    if (otherUse(body) || !sheets.size) return;
    const indent = indentationAt(text, load.getStart());
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const delimiter = text.slice(method.parameters.pos, parameter.getStart()).includes('\n')
      ? ',' + newline + indentationAt(text, parameter.getStart())
      : ', ';
    const edits: TextEdit[] = [
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

function isRelatedLocation(value: unknown): value is RelatedLocation {
  return (
    typeof value === 'object' &&
    value !== null &&
    'file' in value &&
    typeof value.file === 'string' &&
    'line' in value &&
    typeof value.line === 'number' &&
    'column' in value &&
    typeof value.column === 'number'
  );
}

// The first entry of `finding.related`, when it is a location.
function firstRelatedLocation(finding: Finding): RelatedLocation | undefined {
  const { related } = finding;
  if (typeof related !== 'object' || related === null || !(0 in related)) return;
  return isRelatedLocation(related[0]) ? related[0] : undefined;
}

// The name of the identifier a reader call passes, which is how two calls are known to decode the
// same input.
function argumentName(call: CallExpression): string | undefined {
  const [argument] = call.arguments;
  return argument && ts.isIdentifier(argument) ? argument.text : undefined;
}

/** The two reader calls that decode the same upload, the earlier one first. */
interface ReadPair {
  earlier: CallExpression;
  later: CallExpression;
}

/** The statement list that holds the first read and the class whose private readers are called. */
interface ReaderScope {
  firstStatement: Node;
  siblings: Block;
  owner: ClassDeclaration;
}

/** The edits of both readers once they take the shared cache. */
interface PairEdits {
  earlierEdits: ReaderEdits;
  laterEdits: ReaderEdits;
}

// The call the finding points at and the earlier call that its `related` location names.
function readPairOf(finding: Finding, node: Node, sourceFile: SourceFile): ReadPair | undefined {
  const { file } = finding;
  if (file === undefined || !/\.[cm]?tsx?$/i.test(sourceFile.fileName)) return;
  const later = calleeCall(node);
  const related = firstRelatedLocation(finding);
  if (!later || !related || path.resolve(related.file) !== path.resolve(file)) return;
  const offset = sourceFile.getPositionOfLineAndCharacter(related.line - 1, related.column - 1);
  const earlier = calleeCall(ts.getTokenAtPosition(sourceFile, offset));
  if (!earlier) return;
  return { earlier, later };
}

function readerScopeOf({ earlier, later }: ReadPair): ReaderScope | undefined {
  const firstStatement = enclosingStatement(earlier);
  if (!firstStatement || firstStatement.parent !== enclosingStatement(later)?.parent) return;
  const siblings = firstStatement.parent;
  if (!ts.isBlock(siblings)) return;
  const owner = siblings.parent.parent;
  if (!owner || !ts.isClassDeclaration(owner)) return;
  return { firstStatement, siblings, owner };
}

// The cache edits of two different readers of the same input that share no worksheet.
function pairEditsOf(
  { earlier, later }: ReadPair,
  { owner }: ReaderScope,
  cacheName: string,
  text: string,
): PairEdits | undefined {
  const earlierReader = readerOf(earlier, owner);
  const laterReader = readerOf(later, owner);
  if (!earlierReader || !laterReader || earlierReader === laterReader) return;
  if (argumentName(earlier) !== argumentName(later)) return;
  const earlierEdits = readerEdits(earlierReader, cacheName, text);
  const laterEdits = readerEdits(laterReader, cacheName, text);
  if (!earlierEdits || !laterEdits) return;
  if ([...earlierEdits.sheets].some((sheet) => laterEdits.sheets.has(sheet))) return;
  return { earlierEdits, laterEdits };
}

// Three overlapping pairs would each propose a new cache binding in this scope.
function overlapsOtherPair(
  { siblings, owner }: ReaderScope,
  { earlier, later }: ReadPair,
  cacheName: string,
  text: string,
): boolean {
  for (const statement of siblings.statements) {
    const call = awaitedCall(statement);
    if (!call || call === earlier || call === later || argumentName(call) !== argumentName(earlier)) continue;
    const reader = readerOf(call, owner);
    if (reader && readerEdits(reader, cacheName, text)) return true;
  }
  return false;
}

// Declares the cache on its own line right before the first read.
function cacheDeclaration(firstStatement: Node, cacheName: string, text: string): TextEdit | undefined {
  const start = firstStatement.getStart();
  const indent = indentationAt(text, start);
  if (text.slice(lineStart(text, start), start) !== indent) return;
  return {
    start,
    end: start,
    text: 'const ' + cacheName + ': ' + cacheType + ' = {};' + (text.includes('\r\n') ? '\r\n' : '\n') + indent,
  };
}

function shareWorkbook({ finding, node, sourceFile, text }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile || text === undefined) return;
  const pair = readPairOf(finding, node, sourceFile);
  if (!pair) return;
  const scope = readerScopeOf(pair);
  if (!scope) return;
  const cacheName = freshName(sourceFile, 'workbookCache');
  if (!cacheName) return;
  const pairEdits = pairEditsOf(pair, scope, cacheName, text);
  if (!pairEdits) return;
  if (overlapsOtherPair(scope, pair, cacheName, text)) return;
  const declaration = cacheDeclaration(scope.firstStatement, cacheName, text);
  if (!declaration) return;
  return {
    edits: [
      declaration,
      ...[pair.earlier, pair.later].map((call) => ({
        start: call.arguments[0].end,
        end: call.arguments[0].end,
        text: ', ' + cacheName,
      })),
      ...[pairEdits.earlierEdits, pairEdits.laterEdits].flatMap(({ edits }) => edits),
    ],
    separateEdits: true,
    requiresReview: true,
    note: 'One cache lives for this pair of reads. Check that the upload bytes stay unchanged and that both readers can share worksheet state. Each reader still retries a failed decode inside its existing error handler.',
  };
}

export default { 'repeated-workbook-decode': shareWorkbook };
