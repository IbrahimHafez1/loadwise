import ts from 'typescript';
import { hasCommentBetween } from '../../performance/site-fixes/helpers.js';
import { unusedImportBindings } from '../unused-bindings.js';
import type { Node, SourceFile, VariableStatement } from 'typescript';
import type { FixResult, SiteFixBuilder, SiteFixInput, TextEdit } from '../../shared/types.js';

// A statement alone on its line goes together with one line break, so no blank line is left behind.
// The fix hunks are whole lines, so the break before it is dropped; on the first line the
// following line's indentation is. Anything else sharing the line (a trailing comment, another
// statement) would be orphaned by the removal, so there is no edit.
function statementRemoval(sourceFile: SourceFile, node: Node): TextEdit | undefined {
  const { text } = sourceFile;
  const start = node.getStart(sourceFile);
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const nextBreak = text.indexOf('\n', node.end);
  const lineEnd = nextBreak === -1 ? text.length : nextBreak;
  const aloneOnLine = text.slice(lineStart, start).trim() === '' && text.slice(node.end, lineEnd).trim() === '';
  if (!aloneOnLine) return;
  if (lineStart > 0) {
    const breakStart = text[lineStart - 2] === '\r' ? lineStart - 2 : lineStart - 1;
    return { start: breakStart, end: node.end, text: '' };
  }
  const following = /^[ \t]*\r?\n[ \t]*/.exec(text.slice(node.end));
  if (!following) return { start, end: node.end, text: '' };
  // The next line's first character is rewritten in place so the edit reaches that row.
  const reachedEnd = node.end + following[0].length;
  // Nothing follows the line break, so there is no character to rewrite and the edit stops at the end.
  if (reachedEnd >= text.length) return { start, end: text.length, text: '' };
  return { start, end: reachedEnd + 1, text: text.slice(reachedEnd, reachedEnd + 1) };
}

const sharedLineNote =
  'Not applied: the statement shares its line with a comment or another statement that removing it would orphan.';

// The binding a finding sits on: a named or namespace specifier, or the default import's name.
function importBindingAt(node: Node): Node | undefined {
  const specifier = ts.findAncestor(
    node,
    (candidate) => ts.isImportSpecifier(candidate) || ts.isNamespaceImport(candidate),
  );
  if (specifier) return specifier;
  return ts.isIdentifier(node) && ts.isImportClause(node.parent) && node.parent.name === node ? node : undefined;
}

// The unused-import findings of one file are judged against the same set, so one parse serves them all.
const unusedAnchorsBySourceFile = new WeakMap<SourceFile, ReadonlySet<Node>>();

// Siblings are judged without the project's compiler options, which can only keep more of them.
function unusedAnchorsOf(sourceFile: SourceFile): ReadonlySet<Node> {
  const cached = unusedAnchorsBySourceFile.get(sourceFile);
  if (cached) return cached;
  const anchors = new Set<Node>(unusedImportBindings(sourceFile, {}).map((binding) => binding.anchor));
  unusedAnchorsBySourceFile.set(sourceFile, anchors);
  return anchors;
}

// What the clause keeps once its unused parts are gone: the default name, then the namespace or the
// remaining named imports.
function keptClauseParts(clause: ts.ImportClause, unused: ReadonlySet<Node>): string[] {
  const parts: string[] = [];
  if (clause.name && !unused.has(clause.name)) parts.push(clause.name.text);
  const named = clause.namedBindings;
  if (!named) return parts;
  if (ts.isNamespaceImport(named)) {
    if (!unused.has(named)) parts.push(named.getText());
    return parts;
  }
  const keptElements = named.elements.filter((element) => !unused.has(element));
  if (keptElements.length) parts.push(`{ ${keptElements.map((element) => element.getText()).join(', ')} }`);
  return parts;
}

// One edit that rewrites every binding of the clause, whichever of its unused names the finding is
// on. Findings of one import then carry identical edits, which the fix run applies once; separate
// per-name edits would overlap on the same line and be refused or corrupt it.
function clauseRewrite(
  clause: ts.ImportClause,
  unused: ReadonlySet<Node>,
  sourceFile: SourceFile,
): TextEdit | undefined {
  const firstBinding = clause.name ?? clause.namedBindings;
  if (!firstBinding) return;
  return {
    start: firstBinding.getStart(sourceFile),
    end: clause.end,
    text: keptClauseParts(clause, unused).join(', '),
  };
}

function removeUnusedImport({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const target = importBindingAt(node);
  const declaration = target && ts.findAncestor(target, ts.isImportDeclaration);
  const clause = declaration?.importClause;
  if (!target || !declaration || !clause) return;
  const unused = new Set<Node>(unusedAnchorsOf(sourceFile));
  unused.add(target);
  if (keptClauseParts(clause, unused).length === 0) {
    const removal = statementRemoval(sourceFile, declaration);
    if (!removal) return { edits: [], note: sharedLineNote };
    // Dropping a whole import also drops whatever running the module did, unless it only held types.
    return {
      edits: [removal],
      ...(!clause.isTypeOnly && {
        requiresReview: true,
        note: 'Removes the whole import. If the module is loaded for its side effects, keep it as a bare `import "module"` instead.',
      }),
    };
  }
  const edit = clauseRewrite(clause, unused, sourceFile);
  if (!edit) return;
  // The rewrite regenerates the clause from its names, so a comment inside it would be lost.
  if (hasCommentBetween(sourceFile.text, edit.start, edit.end)) {
    return { edits: [], note: 'Not applied: the import clause contains comments that rewriting it would remove.' };
  }
  return { edits: [edit], note: 'Removes only the unused name from the import.' };
}

// Evaluating these can neither throw nor change anything, so deleting the declaration is safe.
function pureInitializer(initializer: ts.Expression | undefined): boolean {
  if (!initializer) return true;
  if (ts.isPrefixUnaryExpression(initializer)) return ts.isNumericLiteral(initializer.operand);
  return (
    ts.isNumericLiteral(initializer) ||
    ts.isBigIntLiteral(initializer) ||
    ts.isStringLiteral(initializer) ||
    ts.isNoSubstitutionTemplateLiteral(initializer) ||
    ts.isRegularExpressionLiteral(initializer) ||
    ts.isIdentifier(initializer) ||
    ts.isArrowFunction(initializer) ||
    ts.isFunctionExpression(initializer) ||
    initializer.kind === ts.SyntaxKind.TrueKeyword ||
    initializer.kind === ts.SyntaxKind.FalseKeyword ||
    initializer.kind === ts.SyntaxKind.NullKeyword
  );
}

function onlyStatementOf(declaration: ts.VariableDeclaration): VariableStatement | undefined {
  const statement = declaration.parent.parent;
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return;
  const container = statement.parent;
  return ts.isBlock(container) || ts.isSourceFile(container) || ts.isCaseClause(container) ? statement : undefined;
}

function removeUnusedLocal({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const declaration = ts.findAncestor(node, ts.isVariableDeclaration);
  const statement = declaration && onlyStatementOf(declaration);
  if (!declaration || !statement || !pureInitializer(declaration.initializer)) return;
  const removal = statementRemoval(sourceFile, statement);
  if (!removal) return { edits: [], note: sharedLineNote };
  return {
    edits: [removal],
    note: 'Removes a variable that is never read; its initializer has no side effects.',
  };
}

const builders: Record<string, SiteFixBuilder> = {
  'unused-import': removeUnusedImport,
  'unused-local-variable': removeUnusedLocal,
};

export default builders;
