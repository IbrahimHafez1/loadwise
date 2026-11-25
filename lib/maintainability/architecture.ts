import ts from 'typescript';
import { checkGraph } from './graph.js';
import { nestForwardReferences } from './architecture-nest.js';
import { childBuffer, bufferChildren } from './child-buffer.js';
import type {
  CallExpression,
  CompilerOptions,
  ExportDeclaration,
  Expression,
  ExpressionWithTypeArguments,
  Identifier,
  ImportClause,
  HasDecorators,
  Node,
  SourceFile,
  Statement,
  StringLiteralLike,
  SyntaxKind,
  TypeNode,
} from 'typescript';
import type { ImportKind, LocatedFinding, ModuleEdge, FolderBoundary } from './types/module-graph.js';
import type { SpecifierResolver } from './types/module-resolver.js';

// A module specifier the walk found, with whether loading it is immediate or deferred.
interface LoaderReference {
  literal: StringLiteralLike;
  kind: ImportKind;
  constEnumNames?: string[];
}

// An import whose bindings are only loaded if one of them is read at run time.
interface ImportRecord {
  literal: StringLiteralLike;
  bindings: string[];
  // Local name to exported name of each named value import.
  named?: Map<string, string>;
}

interface ImportCollections {
  references: LoaderReference[];
  candidates: Set<string>;
  imports: ImportRecord[];
  used: Set<string>;
}

interface ArchitectureFile {
  sourceFile: SourceFile;
  file: string;
  compilerOptions?: CompilerOptions;
}

interface ArchitectureInput {
  files: readonly ArchitectureFile[];
  resolve: SpecifierResolver;
  boundaries?: readonly FolderBoundary[];
}

function importBindings(clause: ImportClause): string[] {
  if (clause.isTypeOnly) return [];
  const bindings = clause.name ? [clause.name.text] : [];
  if (!clause.namedBindings) return bindings;
  if (ts.isNamespaceImport(clause.namedBindings)) bindings.push(clause.namedBindings.name.text);
  else for (const item of clause.namedBindings.elements) if (!item.isTypeOnly) bindings.push(item.name.text);
  return bindings;
}

function isSyntaxNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'kind' in value && typeof value.kind === 'number';
}

// The name a declaration statement gives, whichever kind of statement it is.
function declaredName(node: Node): Node | undefined {
  return 'name' in node && isSyntaxNode(node.name) ? node.name : undefined;
}

// Whether `parent` declares `node` as its name or as the imported name it renames.
function namesBinding(parent: Node, node: Node): boolean {
  return ('name' in parent && parent.name === node) || ('propertyName' in parent && parent.propertyName === node);
}

function isClassBase(node: Node): node is ExpressionWithTypeArguments {
  return (
    ts.isExpressionWithTypeArguments(node) &&
    ts.isHeritageClause(node.parent) &&
    node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
    ts.isClassLike(node.parent.parent)
  );
}

function introducesBinding(node: Node): boolean {
  const parent = node.parent;
  return (
    'name' in parent &&
    parent.name === node &&
    (ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportEqualsDeclaration(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent))
  );
}

function bindingScope(name: Node): Node | undefined {
  let current: Node = name.parent;
  while (ts.isBindingElement(current)) current = current.parent.parent;
  const declaration = current;
  if (ts.isParameter(declaration)) return declaration.parent;
  if (ts.isFunctionExpression(declaration) || ts.isClassExpression(declaration)) return declaration;
  const variable = ts.isVariableDeclaration(declaration);
  if (variable && ts.isCatchClause(declaration.parent)) return declaration.parent;
  const blockScoped = !variable || Boolean(declaration.parent.flags & ts.NodeFlags.BlockScoped);
  for (let scope: Node | undefined = declaration.parent; scope; scope = scope.parent) {
    if (
      ts.isFunctionLike(scope) ||
      ts.isSourceFile(scope) ||
      (blockScoped &&
        (ts.isBlock(scope) ||
          ts.isCaseBlock(scope) ||
          ts.isForStatement(scope) ||
          ts.isForInStatement(scope) ||
          ts.isForOfStatement(scope)))
    )
      return scope;
  }
}

function conditionallyExecuted(node: Node): boolean {
  if (
    ts.isFunctionLike(node) ||
    ts.isIfStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isTryStatement(node) ||
    ts.isConditionalExpression(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isCallChain(node) ||
    ts.isElementAccessChain(node)
  )
    return true;
  if (!ts.isBinaryExpression(node)) return false;
  const operator = node.operatorToken.kind;
  return (
    operator === ts.SyntaxKind.AmpersandAmpersandToken ||
    operator === ts.SyntaxKind.BarBarToken ||
    operator === ts.SyntaxKind.QuestionQuestionToken ||
    operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    operator === ts.SyntaxKind.BarBarEqualsToken ||
    operator === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

function isTypeThunk(argument: Expression): boolean {
  return ts.isArrowFunction(argument) || ts.isFunctionExpression(argument);
}

//  and  both name their type lazily.
// A relation decorator callback and Nest's forwardRef callback both name their type lazily.
function hasLazyTypeDecorator(node: HasDecorators): boolean {
  return (ts.getDecorators(node) || []).some(
    (decorator) =>
      ts.isCallExpression(decorator.expression) &&
      decorator.expression.arguments.some(
        (argument) => isTypeThunk(argument) || (ts.isCallExpression(argument) && argument.arguments.some(isTypeThunk)),
      ),
  );
}

const noTypes: readonly (TypeNode | undefined)[] = [];

// Types TypeScript copies into emitted design:type / design:paramtypes metadata, which runs at
// load. A decorator that receives a type thunk, such as a TypeORM relation callback, makes that
// metadata redundant.
function metadataTypes(node: Node): readonly (TypeNode | undefined)[] {
  switch (node.kind) {
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
      break;
    default:
      return noTypes;
  }
  if (ts.isClassDeclaration(node)) {
    if (!ts.getDecorators(node)?.length) return [];
    const constructor = node.members.find(ts.isConstructorDeclaration);
    return constructor
      ? constructor.parameters
          .filter((parameter) => !hasLazyTypeDecorator(parameter))
          .map((parameter) => parameter.type)
      : [];
  }
  const member =
    ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node);
  if (!member || !ts.getDecorators(node)?.length || hasLazyTypeDecorator(node)) return [];
  return ts.isMethodDeclaration(node)
    ? [node.type, ...node.parameters.map((parameter) => parameter.type)]
    : [node.type];
}

function alwaysEvaluatedChild(node: Node, child: Node): boolean {
  if (
    ts.isIfStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isCallChain(node) ||
    ts.isElementAccessChain(node)
  )
    return child === node.expression;
  if (ts.isPropertyDeclaration(node))
    return (
      child !== node.initializer ||
      Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword))
    );
  if (ts.isFunctionLike(node)) return ts.isDecorator(child);
  if (ts.isForStatement(node)) return child === node.initializer || child === node.condition;
  if (ts.isConditionalExpression(node)) return child === node.condition;
  return ts.isBinaryExpression(node) && child === node.left;
}

function collectReexport(
  statement: ExportDeclaration,
  preserveImports: boolean,
  references: LoaderReference[],
  used: Set<string>,
): void {
  const clause = statement.exportClause;
  if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
    if (preserveImports || !clause || !ts.isNamedExports(clause) || clause.elements.some((item) => !item.isTypeOnly)) {
      references.push({ literal: statement.moduleSpecifier, kind: 'eager' });
    }
  } else if (clause && ts.isNamedExports(clause)) {
    for (const item of clause.elements) if (!item.isTypeOnly) used.add((item.propertyName || item.name).text);
  }
}

function collectImportDeclarations(
  sourceFile: SourceFile,
  preserveImports: boolean,
  { references, candidates, imports, used }: ImportCollections,
): void {
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      if (statement.importClause?.isTypeOnly) continue;
      if (preserveImports || !statement.importClause) {
        references.push({ literal: statement.moduleSpecifier, kind: 'eager' });
        continue;
      }
      const bindings = importBindings(statement.importClause);
      for (const binding of bindings) candidates.add(binding);
      imports.push({ literal: statement.moduleSpecifier, bindings, named: namedImports(statement.importClause) });
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression &&
      ts.isStringLiteralLike(statement.moduleReference.expression)
    ) {
      const literal = statement.moduleReference.expression;
      if (preserveImports || statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        references.push({ literal, kind: 'eager' });
      } else {
        candidates.add(statement.name.text);
        imports.push({ literal, bindings: [statement.name.text] });
      }
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      collectReexport(statement, preserveImports, references, used);
    }
  }
}

// Local name → exported name of each named value import, the only form a const enum can be imported
// in.
function namedImports(clause: ImportClause): Map<string, string> {
  const named = new Map<string, string>();
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamedImports(bindings))
    for (const item of bindings.elements)
      if (!item.isTypeOnly) named.set(item.name.text, (item.propertyName || item.name).text);
  return named;
}

// `Name.Member` or `Name['member']`: the only value reads TypeScript inlines for a const enum.
function memberRead(node: Node): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === node;
  return (
    ts.isElementAccessExpression(parent) &&
    parent.expression === node &&
    ts.isStringLiteralLike(parent.argumentExpression)
  );
}

// The exported names an import reads only as `Name.Member`. When each is a const enum of the
// target, tsc inlines the members and drops the import, unless the compiler options keep value
// imports or compile files one at a time.
function constEnumCandidates(
  item: ImportRecord,
  read: (binding: string) => boolean,
  nonMemberReads: ReadonlySet<string>,
  compilerOptions: CompilerOptions,
): string[] | undefined {
  if (!item.named || compilerOptions.isolatedModules || compilerOptions.preserveValueImports) return;
  const names: string[] = [];
  for (const binding of item.bindings) {
    if (!read(binding)) continue;
    const exported = item.named.get(binding);
    if (nonMemberReads.has(binding) || exported === undefined) return;
    names.push(exported);
  }
  return names;
}

function collectLoaderCall(
  node: CallExpression,
  deferred: boolean,
  references: LoaderReference[],
  requires: LoaderReference[],
): void {
  const literal = node.arguments[0];
  if (!literal || !ts.isStringLiteralLike(literal)) return;
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) references.push({ literal, kind: 'deferred' });
  else if (
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    node.arguments.length === 1 &&
    !node.questionDotToken
  )
    requires.push({ literal, kind: deferred ? 'deferred' : 'eager' });
}

function collectEdges(
  sourceFile: SourceFile,
  file: string,
  resolve: SpecifierResolver,
  compilerOptions: CompilerOptions = {},
): ModuleEdge[] {
  if (sourceFile.isDeclarationFile) return [];
  const javascript = /\.[cm]?jsx?$/i.test(sourceFile.fileName);
  const preserveImports = javascript || compilerOptions.verbatimModuleSyntax === true;
  const imports: ImportRecord[] = [];
  const used = new Set<string>();
  const uses: { node: Identifier; deferred: boolean }[] = [];
  const deferredUsed = new Set<string>();
  const metadataUsed = new Set<string>();
  const candidates = new Set<string>();
  const references: LoaderReference[] = [];
  const requires: LoaderReference[] = [];
  const shadowScopes = new Map<string, Set<Node | undefined>>();
  function addShadow(name: string, scope: Node | undefined): void {
    let scopes = shadowScopes.get(name);
    if (!scopes) shadowScopes.set(name, (scopes = new Set()));
    scopes.add(scope);
  }
  function shadowed(name: string, node: Node): boolean {
    const scopes = shadowScopes.get(name);
    if (scopes)
      for (let scope: Node | undefined = node; scope; scope = scope.parent) if (scopes.has(scope)) return true;
    return false;
  }
  collectImportDeclarations(sourceFile, preserveImports, { references, candidates, imports, used });

  // Parallel arrays that never shrink avoid the cost of repeatedly trimming a popped array.
  const stackNodes: Node[] = [];
  const stackDeferred: boolean[] = [];
  let stackTop = 0;
  function pushNode(node: Node, deferred: boolean): void {
    stackNodes[stackTop] = node;
    stackDeferred[stackTop++] = deferred;
  }
  // Handles one node and queues its children with their deferred flags. The explicit stack below
  // keeps long operator chains off the call stack.
  // loadwise-reviewed high-branch-complexity -- ordered early-return dispatch over node kinds; each guard consumes one kind and the order decides which rule wins, so splitting would scatter that ordering
  function visit(node: Node, deferred: boolean): void {
    if (ts.isIdentifier(node)) {
      if ((node.text === 'require' || candidates.has(node.text)) && introducesBinding(node)) {
        addShadow(node.text, bindingScope(node));
        return;
      }
      const parent = node.parent;
      if (candidates.has(node.text) && (!namesBinding(parent, node) || ts.isShorthandPropertyAssignment(parent)))
        uses.push({ node, deferred });
      return;
    }
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      const clause = ts.isImportEqualsDeclaration(node) ? undefined : node.importClause;
      const bindings = clause?.namedBindings;
      const names = ts.isImportEqualsDeclaration(node)
        ? [node.name]
        : [
            clause?.name,
            bindings && ts.isNamespaceImport(bindings) ? bindings.name : undefined,
            ...(bindings && ts.isNamedImports(bindings) ? bindings.elements : []).map((item) => item.name),
          ];
      if (names.some((name) => name?.text === 'require')) addShadow('require', sourceFile);
      return;
    }
    if (ts.isExportDeclaration(node)) return;
    collectDecoratorMetadataUses(compilerOptions, node, metadataUsed);
    if (isClassBase(node)) {
      pushNode(node.expression, deferred);
      return;
    }
    if (
      ts.isTypeNode(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      (ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword))
    )
      return;
    if (ts.isCallExpression(node)) collectLoaderCall(node, deferred, references, requires);
    if (
      compilerOptions.jsx === ts.JsxEmit.React &&
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node))
    )
      used.add((compilerOptions.jsxFactory || 'React.createElement').split('.')[0]);
    const conditional = !deferred && conditionallyExecuted(node);
    for (let index = bufferChildren(node) - 1; index >= 0; index--) {
      const child = childBuffer[index];
      pushNode(child, deferred || (conditional && !alwaysEvaluatedChild(node, child)));
      // Decorators run when the class is defined, even for members whose bodies run later.
      if (conditional && ts.isParameter(child))
        for (const decorator of ts.getDecorators(child) || []) pushNode(decorator, false);
    }
  }
  if (candidates.size || sourceFile.text.includes('require') || sourceFile.text.includes('import')) {
    pushNode(sourceFile, false);
    while (stackTop > 0) {
      stackTop--;
      visit(stackNodes[stackTop], stackDeferred[stackTop]);
    }
  }
  const nonMemberReads = new Set<string>();
  for (const { node, deferred } of uses) {
    if (shadowed(node.text, node)) continue;
    (deferred ? deferredUsed : used).add(node.text);
    if (!memberRead(node)) nonMemberReads.add(node.text);
  }
  const read = (binding: string): boolean => used.has(binding) || deferredUsed.has(binding);
  // A binding read only inside function bodies (for example a TypeORM entity callback) is not
  // evaluated while the module loads, so it cannot close a load-time cycle.
  for (const item of imports) {
    let kind: ImportKind;
    if (item.bindings.some((binding) => used.has(binding))) kind = 'eager';
    else if (item.bindings.some((binding) => deferredUsed.has(binding)))
      kind = item.bindings.some((binding) => metadataUsed.has(binding)) ? 'eager' : 'deferred';
    else continue;
    const constEnumNames = constEnumCandidates(item, read, nonMemberReads, compilerOptions);
    references.push({ literal: item.literal, kind, ...(constEnumNames && { constEnumNames }) });
  }
  for (const item of requires) {
    if (!shadowed('require', item.literal)) references.push(item);
  }
  return resolveEdges(sourceFile, file, resolve, references);
}

function resolveEdges(
  sourceFile: SourceFile,
  file: string,
  resolve: SpecifierResolver,
  references: readonly LoaderReference[],
): ModuleEdge[] {
  const edges: ModuleEdge[] = [];
  const forwardReferences = nestForwardReferences(sourceFile, resolve);
  for (const { literal, kind, constEnumNames } of references) {
    const target = resolve(literal.text, sourceFile.fileName, literal);
    if (!target) continue;
    const position = sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile));
    const edge: ModuleEdge = { from: file, to: target, line: position.line + 1, column: position.character + 1, kind };
    if (constEnumNames) edge.constEnumNames = constEnumNames;
    // Nest forwardRef cycles stay reported, with their contextual reason, rather than disappearing.
    if (forwardReferences?.has(literal)) {
      edge.nestForwardRef = true;
      edge.kind = 'eager';
    }
    edges.push(edge);
  }
  return edges;
}

function collectDecoratorMetadataUses(compilerOptions: CompilerOptions, node: Node, metadataUsed: Set<string>): void {
  if (compilerOptions.emitDecoratorMetadata) {
    for (const type of metadataTypes(node)) {
      let name = type && ts.isTypeReferenceNode(type) ? type.typeName : undefined;
      while (name && ts.isQualifiedName(name)) name = name.left;
      if (name) metadataUsed.add(name.text);
    }
  }
}

const constEnumModifiers = new Set([
  ts.SyntaxKind.ConstKeyword,
  ts.SyntaxKind.ExportKeyword,
  ts.SyntaxKind.DeclareKeyword,
]);

function hasModifier(statement: Statement, kind: SyntaxKind): boolean {
  return Boolean(
    ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((modifier) => modifier.kind === kind),
  );
}

// Top-level names a statement gives a runtime value (or an alias that may hold one).
function valueNames(statement: Statement): string[] {
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (!bindings) return clause?.name ? [clause.name.text] : [];
    const names = ts.isNamespaceImport(bindings) ? [bindings.name] : bindings.elements.map((item) => item.name);
    return [clause.name, ...names].filter((name): name is Identifier => name !== undefined).map((name) => name.text);
  }
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return [];
  const name = declaredName(statement);
  return name && ts.isIdentifier(name) ? [name.text] : [];
}

function recordNamedExports(statement: ExportDeclaration, exported: Map<string, string>): void {
  const clause = statement.exportClause;
  if (statement.moduleSpecifier || statement.isTypeOnly || !clause || !ts.isNamedExports(clause)) return;
  for (const item of clause.elements) exported.set(item.name.text, (item.propertyName || item.name).text);
}

// Names the module exports that are declared only as const enums, so no runtime value backs them. A
// name that also merges with a namespace, function, class or variable, or that a re-export
// forwards, does not count.
function exportedConstEnums(sourceFile: SourceFile): string[] {
  const constEnums = new Set<string>();
  const values = new Set<string>();
  const exported = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (ts.isEnumDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.ConstKeyword)) {
      const name = statement.name.text;
      if (ts.getModifiers(statement)?.some((modifier) => !constEnumModifiers.has(modifier.kind))) values.add(name);
      constEnums.add(name);
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) exported.set(name, name);
    } else if (ts.isExportDeclaration(statement)) {
      recordNamedExports(statement, exported);
    } else {
      for (const name of valueNames(statement)) values.add(name);
    }
  }
  return [...exported].filter(([, local]) => constEnums.has(local) && !values.has(local)).map(([name]) => name);
}

function analyzeArchitecture({ files, resolve, boundaries }: ArchitectureInput): LocatedFinding[] {
  const names: string[] = [],
    edges: ModuleEdge[] = [],
    constEnums = new Map<string, string[]>();
  for (const { sourceFile, file, compilerOptions } of files) {
    names.push(file);
    constEnums.set(file, exportedConstEnums(sourceFile));
    for (const edge of collectEdges(sourceFile, file, resolve, compilerOptions)) edges.push(edge);
  }
  return checkGraph({ files: names, edges, boundaries, constEnums });
}

export {
  analyzeArchitecture,
  checkGraph,
  collectEdges,
  declaredName,
  exportedConstEnums,
  introducesBinding,
  bindingScope,
};
