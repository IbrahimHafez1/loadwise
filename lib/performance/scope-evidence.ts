import type { Expression, Node } from 'typescript';
import type { CheckerAdapter, ScopePolicy, SymbolAdapter, TypeAdapter } from '../shared/types.js';
import { ts } from './compiler.js';

function plain(node: Expression): Expression;
function plain(node: Expression | undefined): Expression | undefined;
function plain(node: Node): Node;
function plain(node: Node | undefined): Node | undefined {
  while (node && (ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
  return node;
}

function fields(expression: Expression): Map<string, Expression> | undefined {
  const node = plain(expression);
  if (!node || !ts.isObjectLiteralExpression(node)) return;
  const values = new Map<string, Expression>();
  for (const property of node.properties) {
    if (
      !(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) ||
      !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ||
      values.has(property.name.text) ||
      property.name.text === '__proto__'
    )
      return;
    values.set(property.name.text, ts.isPropertyAssignment(property) ? property.initializer : property.name);
  }
  return values;
}

function scalar(type: TypeAdapter, nullable: boolean): boolean {
  // `types` is read only on unions and intersections; other native types cannot answer it.
  if (type.isUnion()) {
    const members = type.types ?? [];
    return members.length > 0 && members.every((member) => scalar(member, nullable));
  }
  // A branded primitive is still its underlying scalar at runtime.
  if (type.flags & ts.TypeFlags.Intersection) return (type.types ?? []).some((member) => scalar(member, nullable));
  const flags = ts.TypeFlags;
  return Boolean(
    type.flags &
    (flags.StringLike |
      flags.NumberLike |
      flags.BigIntLike |
      flags.BooleanLike |
      (nullable ? flags.Null | flags.Undefined : 0)),
  );
}

function importedMember(target: Expression, checker: CheckerAdapter): { from: string; exported: string } | undefined {
  const callee = plain(target);
  const qualified = ts.isPropertyAccessExpression(callee);
  if (qualified && ts.isOptionalChain(callee)) return;
  const identifier = qualified ? callee.expression : callee;
  if (!ts.isIdentifier(identifier)) return;
  const binding = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  if (!binding) return;
  const statement = ts.findAncestor(binding, ts.isImportDeclaration);
  if (
    !statement ||
    statement.importClause?.isTypeOnly ||
    !ts.isStringLiteral(statement.moduleSpecifier) ||
    ('isTypeOnly' in binding && binding.isTypeOnly)
  )
    return;
  let exported: string | undefined;
  if (qualified && ts.isNamespaceImport(binding)) exported = callee.name.text;
  if (!qualified && ts.isImportClause(binding)) exported = 'default';
  if (!qualified && ts.isImportSpecifier(binding)) exported = (binding.propertyName ?? binding.name).text;
  if (exported) return { from: statement.moduleSpecifier.text, exported };
}

function trustedValue(expression: Expression, scope: ScopePolicy, checker: CheckerAdapter): boolean {
  let node: Expression | undefined = plain(expression);
  const visited = new Set<Node>();
  while (node) {
    if (!scalar(checker.getTypeAtLocation(node), false)) return false;
    if (ts.isIdentifier(node)) {
      const symbol: SymbolAdapter | undefined = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      const declaration: Node | undefined = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (
        !declaration ||
        !ts.isVariableDeclaration(declaration) ||
        visited.has(declaration) ||
        !(declaration.parent.flags & ts.NodeFlags.Const)
      )
        return false;
      visited.add(declaration);
      node = plain(declaration.initializer);
      continue;
    }
    if (ts.isAwaitExpression(node)) node = plain(node.expression);
    if (!ts.isCallExpression(node) || ts.isOptionalChain(node)) return false;
    const imported = importedMember(node.expression, checker);
    return !!imported && imported.from === scope.from && imported.exported === scope.export;
  }
  return false;
}

// A generated filter must read the trusted binding visible at this exact query, after
// initialization.
function scopeFixEvidence(
  site: Node,
  scope: ScopePolicy,
  checker: CheckerAdapter,
): { verifiedScopeField: string } | undefined {
  const symbol = checker.resolveName(scope.field, site, ts.SymbolFlags.Value, true);
  const declaration = symbol?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return;
  const statement = declaration.parent.parent;
  if (!ts.isVariableStatement(statement) || statement.end > site.getStart()) return;
  const enclosing = ts.findAncestor(site, (node: Node) => node === statement.parent || ts.isFunctionLike(node));
  if (enclosing !== statement.parent || !trustedValue(declaration.name, scope, checker)) return;
  return { verifiedScopeField: scope.field };
}

function scopedData(
  expression: Expression,
  scope: ScopePolicy,
  checker: CheckerAdapter,
  creating: boolean,
  allowPrismaSet = true,
): boolean {
  const data = fields(expression);
  if (!data || (creating && !data.has(scope.field))) return false;
  for (const [field, value] of data) {
    const node = plain(value);
    if (field === scope.field) {
      const assignment = fields(value);
      const setValue = assignment?.size === 1 ? assignment.get('set') : undefined;
      if (
        !trustedValue(value, scope, checker) &&
        !(!creating && allowPrismaSet && setValue !== undefined && trustedValue(setValue, scope, checker))
      )
        return false;
    } else if (
      ts.isObjectLiteralExpression(node) ||
      ts.isArrayLiteralExpression(node) ||
      ts.isAsExpression(node) ||
      node.kind === ts.SyntaxKind.TypeAssertionExpression ||
      !scalar(checker.getTypeAtLocation(value), true)
    ) {
      // A nested Prisma relation write can change ownership through another model.
      return false;
    }
  }
  return true;
}

function scopeEvidence() {
  return { fields, importedMember, plain, scalar, scopedData, scopeFixEvidence, trustedValue };
}

export { scopeEvidence };
