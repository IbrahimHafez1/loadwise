import ts from 'typescript';
import type {
  Expression,
  FunctionDeclaration,
  Node,
  ObjectLiteralElementLike,
  PropertyAssignment,
  PropertyName,
  SourceFile,
  VariableStatement,
} from 'typescript';
import type { CodeFramework, FunctionLike, UpFunction } from './extract-code-types.cjs';

const TYPEORM_SIGNATURE = /\bMigrationInterface\b|\bQueryRunner\b|\bqueryRunner\b/;

const SEQUELIZE_SIGNATURE = /\bqueryInterface\b|\bQueryInterface\b/;

const KNEX_SIGNATURE = /\bknex\b|\bKnex\b/;

// `@mikro-orm/migrations`, or a framework re-export such as Medusa's
// `@medusajs/framework/mikro-orm/migrations`.
const MIKRO_ORM_IMPORT = /\bfrom\s+['"][^'"]*mikro-orm\/migrations['"]/;

const MIKRO_ORM_CLASS = /\bextends\s+Migration\b/;

export function scriptKindFor(file: string) {
  if (/\.[cm]?tsx?$/i.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

export function detectFramework(text: string): CodeFramework {
  if (MIKRO_ORM_IMPORT.test(text) && MIKRO_ORM_CLASS.test(text)) return 'mikro-orm';
  if (TYPEORM_SIGNATURE.test(text)) return 'typeorm';
  if (SEQUELIZE_SIGNATURE.test(text)) return 'sequelize';
  if (KNEX_SIGNATURE.test(text)) return 'knex';
  return 'unknown';
}

export function propertyName(name: PropertyName | undefined) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  return null;
}

export function isFunctionLike(node: Node | undefined): node is FunctionLike {
  return (
    node !== undefined &&
    (ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionDeclaration(node))
  );
}

function isExportsMember(expression: Expression, member: string) {
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== member) return false;
  const target = expression.expression;
  if (ts.isIdentifier(target)) return target.text === 'exports';
  return (
    ts.isPropertyAccessExpression(target) &&
    target.name.text === 'exports' &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === 'module'
  );
}

// `up` as a class method, an object-literal member, `exports.up = ...` or an exported
// function/const.
export function findUpFunctions(sourceFile: SourceFile) {
  const found: UpFunction[] = [];
  const visit = (node: Node) => {
    if ((ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) && propertyName(node.name) === 'up') {
      const target = ts.isPropertyAssignment(node) ? node.initializer : node;
      if (isFunctionLike(target)) found.push({ fn: target, owner: node.parent });
    } else if (ts.isPropertyDeclaration(node) && propertyName(node.name) === 'up' && isFunctionLike(node.initializer)) {
      found.push({ fn: node.initializer, owner: node.parent });
    } else if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'up') {
      const declared = findDeclaration(node, 'up');
      if (declared) found.push({ fn: declared, owner: node.parent });
    } else if (ts.isFunctionDeclaration(node) && node.name?.text === 'up' && hasExportModifier(node)) {
      found.push({ fn: node, owner: sourceFile });
    } else if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (declaration.name.getText(sourceFile) === 'up' && isFunctionLike(declaration.initializer)) {
          found.push({ fn: declaration.initializer, owner: sourceFile });
        }
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isExportsMember(node.left, 'up') &&
      isFunctionLike(node.right)
    ) {
      found.push({ fn: node.right, owner: sourceFile });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function hasExportModifier(node: FunctionDeclaration | VariableStatement) {
  return (ts.getModifiers?.(node) ?? node.modifiers ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function isFalseLiteral(node: Node | undefined) {
  let current = node;
  while (current && (ts.isAsExpression(current) || ts.isParenthesizedExpression(current))) current = current.expression;
  return current?.kind === ts.SyntaxKind.FalseKeyword;
}

export function objectProperty(objectLiteral: Node | undefined, name: string): PropertyAssignment | undefined {
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) return undefined;
  return objectLiteral.properties.find(
    (property: ObjectLiteralElementLike): property is PropertyAssignment =>
      ts.isPropertyAssignment(property) && propertyName(property.name) === name,
  );
}

function typeormClassDisablesTransaction(owner: Node | undefined) {
  if (!owner || !ts.isClassLike(owner)) return false;
  return owner.members.some(
    (member) =>
      ts.isPropertyDeclaration(member) &&
      propertyName(member.name) === 'transaction' &&
      isFalseLiteral(member.initializer),
  );
}

// `exports.config = { transaction: false }` or `export const config = { transaction: false }`.
function knexDisablesTransaction(sourceFile: SourceFile) {
  let disabled = false;
  const visit = (node: Node) => {
    if (disabled) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isExportsMember(node.left, 'config')
    ) {
      disabled = isFalseLiteral(objectProperty(node.right, 'transaction')?.initializer);
    } else if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === 'config') {
      disabled = isFalseLiteral(objectProperty(node.initializer, 'transaction')?.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return disabled;
}

// MikroORM runs each migration in a transaction unless the class overrides `isTransactional()` to
// return false.
function mikroOrmClassDisablesTransaction(owner: Node | undefined) {
  if (!owner || !ts.isClassLike(owner)) return false;
  return owner.members.some(
    (member) =>
      ts.isMethodDeclaration(member) &&
      propertyName(member.name) === 'isTransactional' &&
      (member.body?.statements ?? []).some(
        (statement) => ts.isReturnStatement(statement) && isFalseLiteral(statement.expression),
      ),
  );
}

export function defaultTransaction(framework: CodeFramework, owner: Node | undefined, sourceFile: SourceFile) {
  if (framework === 'mikro-orm') return !mikroOrmClassDisablesTransaction(owner);
  if (framework === 'typeorm') return !typeormClassDisablesTransaction(owner);
  if (framework === 'knex') return !knexDisablesTransaction(sourceFile);
  return false;
}

// Finds a `const name = <initializer>` visible from `node` by walking enclosing blocks.
export function findDeclaration(node: Node, name: string): FunctionDeclaration | Expression | undefined {
  // Binding the syntax tree honors lexical shadowing without building a TypeScript project.
  const source = node.getSourceFile();
  if (!source.locals) ts.bindSourceFile(source, {});
  const key = ts.escapeLeadingUnderscores(name);
  for (let scope: Node | undefined = node.parent; scope; scope = scope.parent) {
    const local = scope.locals?.get(key);
    if (!local) continue;
    const binding = local.exportSymbol ?? local;
    if (!(binding.flags & (ts.SymbolFlags.Value | ts.SymbolFlags.Alias))) continue;
    const declaration = binding.valueDeclaration;
    if (declaration && ts.isFunctionDeclaration(declaration)) return declaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const)
      return declaration.initializer;
    return;
  }
}

export function unwrapExpression(node: Node): Node;

export function unwrapExpression(node: Node | undefined): Node | undefined;

export function unwrapExpression(node: Node | undefined): Node | undefined {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression?.(current))
  ) {
    current = current.expression;
  }
  return current;
}
