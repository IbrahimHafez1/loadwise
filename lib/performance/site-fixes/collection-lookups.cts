// Site fixes for rebuild-lookup-in-loop, promise-combinator-serial-await and
// known-reads-awaited-serially.
import { ts, textOf, ancestor, calleeCall, freshName } from './helpers.cjs';
import type { FixResult, SiteFixInput, TextEdit } from '../../shared/types.cjs';
import { skipParentheses, outerParenthesized, hoistPlacement, mentionsName } from './collection-helpers.cjs';

export function rebuildLookupFix({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const constructed = ancestor(node, ts.isNewExpression);
  if (!constructed || constructed.getStart() !== node.getStart() || !ts.isIdentifier(constructed.expression)) return;
  const kind = constructed.expression.text;
  if (kind !== 'Map' && kind !== 'Set') return;
  if (constructed.arguments?.length !== 1) return;
  const source = skipParentheses(constructed.arguments[0]);
  const use = outerParenthesized(constructed).parent;
  if (!ts.isIdentifier(source) || !ts.isPropertyAccessExpression(use)) return;
  const lookupName = freshName(sourceFile, `${source.text}${kind}`);
  if (!lookupName) return;
  const placement = hoistPlacement(constructed, source.text);
  if (!placement) return;
  return {
    edits: [
      ...placement.edits(`const ${lookupName} = new ${kind}(${source.text});`),
      { start: constructed.getStart(), end: constructed.end, text: lookupName },
    ],
    note: `${source.text} must not change while the iteration runs; ${lookupName} is a snapshot taken before it.`,
  };
}

export function promiseCombinatorFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const call = calleeCall(node);
  if (!call || call.arguments.length !== 1) return;
  const [list] = call.arguments;
  if (!ts.isArrayLiteralExpression(list)) return;
  const edits: TextEdit[] = [];
  for (const element of list.elements) {
    const awaited = skipParentheses(element);
    if (!ts.isAwaitExpression(awaited)) return;
    edits.push({ start: awaited.getStart(), end: awaited.expression.getStart(), text: '' });
  }
  return {
    edits,
    note: 'The calls now start together. Check that none depends on another finishing first, and that an earlier rejection should not stop later calls from running.',
  };
}

export function knownReadsFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const awaited = ancestor(node, ts.isAwaitExpression);
  if (!awaited) return;
  const declaration = awaited.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return;
  const statement = declaration.parent.parent;
  const block = statement.parent;
  if (!ts.isVariableStatement(statement) || !(ts.isBlock(block) || ts.isSourceFile(block))) return;
  const index = block.statements.indexOf(statement);
  const previous = block.statements[index - 1];
  if (!previous || !ts.isVariableStatement(previous)) return;
  const first = previous.declarationList.declarations[0];
  if (
    previous.modifiers ||
    statement.modifiers ||
    previous.declarationList.declarations.length !== 1 ||
    !(previous.declarationList.flags & ts.NodeFlags.Const) ||
    !(statement.declarationList.flags & ts.NodeFlags.Const) ||
    !ts.isIdentifier(first.name) ||
    first.type ||
    declaration.type ||
    !first.initializer ||
    !ts.isAwaitExpression(first.initializer)
  )
    return;
  const sourceText = statement.getSourceFile().text;
  if (sourceText.slice(previous.end, statement.getStart()).trim()) return;
  if (mentionsName(awaited.expression, first.name.text)) return;
  const names = `${first.name.text}, ${declaration.name.text}`;
  const calls = `${textOf(first.initializer.expression)}, ${textOf(awaited.expression)}`;
  return {
    edits: [
      {
        start: previous.getStart(),
        end: statement.end,
        text: `const [${names}] = await Promise.all([${calls}]);`,
      },
    ],
    note: 'Both reads start together; if the first rejects, the second still runs to completion.',
  };
}
