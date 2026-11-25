// Recognises which library a call goes to. The import tier reads only project-local syntax (import
// and require bindings, type annotations), so it works when node_modules is missing; the type tier
// needs installed packages. The import tier is tried first: with types installed a call is
// recognised whenever it is without them, so a rule never reports more findings with fewer types.
import { ts, isDefaultLibrary } from '../performance/compiler.js';
import { declaredNameOf } from './declarations.js';
import type {
  BindingElement,
  CallExpression,
  EntityName,
  Expression,
  ImportClause,
  ImportEqualsDeclaration,
  ImportSpecifier,
  MemberName,
  ModuleDeclaration,
  NamespaceImport,
  NewExpression,
  Node,
  NodeArray,
  StringLiteral,
  StringLiteralLike,
  TypeNode,
  VariableDeclaration,
} from 'typescript';
import type { CheckerAdapter, LibraryCall, ModuleBinding, RuleContext, SignatureAdapter } from '../shared/types.js';

// Method names that belong to one library in practice, so the bare name identifies it. Never add
// generic names such as query, get, raw, exec, find, save, sign or verify.
const uniqueMethodNames = new Set([
  '$queryRawUnsafe',
  '$executeRawUnsafe',
  'whereRaw',
  'havingRaw',
  'orderByRaw',
  'groupByRaw',
  'joinRaw',
  'fromRaw',
  'createQueryBuilder',
  'timingSafeEqual',
]);

// `node:fs` and `fs` are the same module; `@types/express` declares `express`.
function moduleName(specifier: string) {
  return specifier
    .replace(/^node:/, '')
    .replace(/^@types\/(?:([^_/]+)__)?([^/]+)/, (match: string, scope: string | undefined, name: string) =>
      scope ? `@${scope}/${name}` : name,
    );
}

function stripExpression(node: Expression): Expression;
function stripExpression(node: Expression | undefined): Expression | undefined;
function stripExpression(node: Node): Node;
function stripExpression(node: Node | undefined): Node | undefined;
function stripExpression(node: Node | undefined): Node | undefined {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isAwaitExpression(current))
  )
    current = current.expression;
  return current;
}

interface RequireCall extends CallExpression {
  readonly arguments: NodeArray<StringLiteralLike>;
}

function isRequireCall(node: Node | undefined): node is RequireCall {
  return (
    !!node &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  );
}

function importBinding(declaration: ImportSpecifier | ImportClause | NamespaceImport): ModuleBinding | undefined {
  const statement = ts.findAncestor(declaration, ts.isImportDeclaration);
  if (!statement || !ts.isStringLiteral(statement.moduleSpecifier)) return;
  const exported = ts.isImportSpecifier(declaration)
    ? (declaration.propertyName ?? declaration.name).text
    : ts.isImportClause(declaration)
      ? 'default'
      : '*';
  return { module: moduleName(statement.moduleSpecifier.text), exported };
}

function importEqualsBinding(declaration: ImportEqualsDeclaration): ModuleBinding | undefined {
  const reference = declaration.moduleReference;
  if (!ts.isExternalModuleReference(reference) || !ts.isStringLiteral(reference.expression)) return;
  return { module: moduleName(reference.expression.text), exported: '*' };
}

function requiredModuleBinding(declaration: VariableDeclaration): ModuleBinding | undefined {
  const requiredInitializer = stripExpression(declaration.initializer);
  if (!isRequireCall(requiredInitializer)) return;
  if (!ts.isIdentifier(declaration.name)) return;
  return { module: moduleName(requiredInitializer.arguments[0].text), exported: '*' };
}

function destructuredRequireBinding(declaration: BindingElement): ModuleBinding | undefined {
  const variable = declaration.parent.parent;
  if (!ts.isVariableDeclaration(variable)) return;
  const initializer = stripExpression(variable.initializer);
  if (!isRequireCall(initializer)) return;
  const property = declaration.propertyName ?? declaration.name;
  if (!ts.isIdentifier(property)) return;
  return { module: moduleName(initializer.arguments[0].text), exported: property.text };
}

// The module export an import or require binding stands for: { module, exported }, where exported
// is a named export, 'default', or '*' for a namespace or a whole required module.
function bindingOf(declaration: Node | undefined): ModuleBinding | undefined {
  if (!declaration) return;
  if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration))
    return importBinding(declaration);
  if (ts.isImportEqualsDeclaration(declaration)) return importEqualsBinding(declaration);
  if (ts.isVariableDeclaration(declaration) && isRequireCall(stripExpression(declaration.initializer)))
    return requiredModuleBinding(declaration);
  if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent))
    return destructuredRequireBinding(declaration);
}

function declarationOf(identifier: Node, checker: CheckerAdapter): Node | undefined {
  const symbol = ts.isShorthandPropertyAssignment(identifier.parent)
    ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
    : checker.getSymbolAtLocation(identifier);
  return symbol?.declarations?.[0];
}

// `exec` in `import { exec } from 'child_process'` -> { module: 'child_process', exported: 'exec'
// }.
function importedFrom(identifier: Node | undefined, checker: CheckerAdapter): ModuleBinding | undefined {
  if (!identifier || !ts.isIdentifier(identifier)) return;
  return bindingOf(declarationOf(identifier, checker));
}

function typeNameOf(typeNode: TypeNode | undefined): EntityName | undefined {
  if (!typeNode) return;
  if (ts.isTypeReferenceNode(typeNode)) return typeNode.typeName;
  if (ts.isUnionTypeNode(typeNode)) {
    const named = typeNode.types.filter(ts.isTypeReferenceNode);
    return named.length === 1 ? named[0].typeName : undefined;
  }
}

// The receiver's declaration carries a type imported from a module: `private readonly dataSource:
// DataSource` or `model: Model<User>`. This is how NestJS-injected instances are recognised without
// installed packages.
function declaredTypeImport(expression: Expression, checker: CheckerAdapter): ModuleBinding | undefined {
  const node = stripExpression(expression);
  let name: MemberName | undefined;
  if (ts.isIdentifier(node)) name = node;
  else if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) name = node.name;
  if (!name) return;
  const declaration = ts.isIdentifier(node)
    ? declarationOf(node, checker)
    : checker.getSymbolAtLocation(name)?.declarations?.[0];
  if (
    !declaration ||
    !(
      ts.isParameter(declaration) ||
      ts.isPropertyDeclaration(declaration) ||
      ts.isVariableDeclaration(declaration) ||
      ts.isPropertySignature(declaration)
    )
  )
    return;
  const typeName = typeNameOf(declaration.type);
  if (typeName && ts.isQualifiedName(typeName)) {
    const namespace = importedFrom(typeName.left, checker);
    return namespace?.exported === '*' ? { module: namespace.module, exported: typeName.right.text } : undefined;
  }
  return typeName && ts.isIdentifier(typeName) ? importedFrom(typeName, checker) : undefined;
}

// The module a declaration file belongs to: the `declare module 'x'` around it, or its package
// under node_modules.
type AmbientModule = ModuleDeclaration & { name: StringLiteral };

function declaringModule(declaration: Node, checker: CheckerAdapter): string | undefined {
  if (isDefaultLibrary(checker, declaration.getSourceFile())) return;
  const ambient = ts.findAncestor(
    declaration,
    (node: Node): node is AmbientModule => ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name),
  );
  if (ambient) return moduleName(ambient.name.text);
  const filename = declaration.getSourceFile().fileName.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const start = filename.lastIndexOf(marker);
  if (start < 0) return;
  const parts = filename.slice(start + marker.length).split('/');
  return moduleName(parts[0].startsWith('@') ? parts[0] + '/' + parts[1] : parts[0]);
}

function typeTier(
  call: CallExpression | NewExpression,
  receiver: Node | undefined,
  method: string | undefined,
  checker: CheckerAdapter,
): LibraryCall | undefined {
  if (receiver) {
    const type = checker.getTypeAtLocation(receiver);
    const symbol = type.getSymbol() ?? type.aliasSymbol;
    const declaration = symbol?.declarations?.[0];
    const module = declaration && declaringModule(declaration, checker);
    if (module && symbol) return { module, exported: symbol.name, method, tier: 'type' };
  }
  const signature = signatureModule(call, receiver, checker);
  return signature && { ...signature, method, tier: 'type' };
}

function declarationModule(
  declaration: Node | undefined,
  receiver: Node | undefined,
  checker: CheckerAdapter,
): ModuleBinding | undefined {
  const module = declaration && declaringModule(declaration, checker);
  if (!module) return;
  return { module, exported: declaredNameOf(receiver ? declaration.parent : declaration) };
}

// The native adapter resolves a signature's declaration lazily; TypeScript 6 exposes it directly.
function signatureDeclaration(signature: SignatureAdapter): Node | undefined {
  const direct = signature.getDeclaration?.();
  if (direct) return direct;
  const declaration = signature.declaration;
  return declaration && 'resolve' in declaration ? declaration.resolve() : undefined;
}

// Overload resolution checks every argument and dominates a scan's checker time, so it runs only
// when the callee's call signatures disagree on the answer. A callee typed any resolves to a
// signature without a declaration.
function signatureModule(
  call: CallExpression | NewExpression,
  receiver: Node | undefined,
  checker: CheckerAdapter,
): ModuleBinding | undefined {
  const callee = call.expression;
  if ((ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)) && !ts.isOptionalChain(call)) {
    const type = checker.getTypeAtLocation(callee);
    if (type.flags & ts.TypeFlags.Any) return;
    const candidates: (ModuleBinding | undefined)[] = type.isUnion()
      ? []
      : type
          .getCallSignatures()
          .map((signature) => declarationModule(signatureDeclaration(signature), receiver, checker));
    const [first] = candidates;
    const agrees = (other: ModuleBinding | undefined) =>
      other?.module === first?.module && other?.exported === first?.exported;
    if (candidates.length && candidates.every(agrees)) return first;
  }
  return declarationModule(checker.getResolvedSignature(call)?.declaration, receiver, checker);
}

// The identifier a call chain starts from: `knex` in `knex('users').whereRaw(...)`.
function chainRoot(expression: Expression): Expression {
  let node = stripExpression(expression);
  while (
    node &&
    (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node) || ts.isElementAccessExpression(node))
  ) {
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) return node;
    node = stripExpression(node.expression);
  }
  return node;
}

// { module, exported, method, tier } for a call, or undefined. `method` is the called property
// name, undefined when the export itself is called; for a namespace or whole-module binding,
// `fs.readFile()` gives exported 'readFile'.
function libraryCall(
  call: CallExpression | NewExpression,
  context: Pick<RuleContext, 'checker'>,
): LibraryCall | undefined {
  const checker = context.checker;
  const callee = stripExpression(call.expression);
  const access = ts.isPropertyAccessExpression(callee) ? callee : undefined;
  const method = access?.name.text;
  if (!access && ts.isIdentifier(callee)) {
    const binding = importedFrom(callee, checker);
    if (binding) return { ...binding, method: undefined, tier: 'import' };
  }
  if (access) {
    const receiver = stripExpression(access.expression);
    const direct = ts.isIdentifier(receiver) ? importedFrom(receiver, checker) : undefined;
    if (direct?.exported === '*') return { module: direct.module, exported: method, method: undefined, tier: 'import' };
    if (direct) return { ...direct, method, tier: 'import' };
    if (isRequireCall(receiver))
      return { module: moduleName(receiver.arguments[0].text), exported: method, method: undefined, tier: 'import' };
    const annotated = declaredTypeImport(receiver, checker);
    if (annotated) return { ...annotated, method, tier: 'import' };
    const root = chainRoot(receiver);
    const rootBinding =
      root &&
      root !== receiver &&
      (ts.isIdentifier(root) ? importedFrom(root, checker) : declaredTypeImport(root, checker));
    if (rootBinding) return { ...rootBinding, method, tier: 'import' };
  }
  const typed = typeTier(call, access && stripExpression(access.expression), method, checker);
  if (typed) return typed;
  if (method && uniqueMethodNames.has(method)) return { module: undefined, exported: undefined, method, tier: 'name' };
}

export { stripExpression, libraryCall, importedFrom, declaredTypeImport, uniqueMethodNames, moduleName };
