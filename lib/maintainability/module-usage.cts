import path from 'node:path';
import { isBuiltin } from 'node:module';
import ts from 'typescript';
import { declaredName } from './architecture.cjs';
import { walkNodes } from './walk.cjs';
import {
  bindingNames,
  isShadowed,
  metaUrlLoad,
  nodeWorkerModule,
  numericConstant,
  resolvedPath,
  specifierHead,
  startsInTemporaryDirectory,
  urlModule,
  workerBindingScopes,
} from './module-usage-dynamic.cjs';
import type { UrlModule } from './module-usage-dynamic.cjs';
import type {
  BindingName,
  CallExpression,
  ClassElement,
  ExportAssignment,
  ExportDeclaration,
  Expression,
  Identifier,
  ImportDeclaration,
  NamedExportBindings,
  NewExpression,
  Node,
  SignatureDeclaration,
  SourceFile,
  Statement,
  StringLiteralLike,
  SyntaxKind,
} from 'typescript';
import type { FixChange } from '../shared/types.cjs';
import type { SpecifierResolver } from './types/module-resolver.cjs';
import type {
  DynamicLoadSite,
  ExportedName,
  ImportedNames,
  ModuleImport,
  ModuleReexport,
  ModuleUsage,
  UncertainTypeImport,
  UnresolvedImport,
} from './types/module-usage.cjs';
const nodeShebang = /^#![ \t]*(?:\/[^\s]*\/env[ \t]+(?:-S[ \t]+)?node|\/(?:[^/\s]+\/)*node)(?=[ \t\r\n]|$)/;

// What one file exports, and which names of which resolved project files it uses. Plain data, so a
// worker thread can send it back. `names: 'all'` means the whole module is used, as with a
// namespace import or require().
function hasModifier(node: Node, kind: SyntaxKind): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

// A declared export: its exported name and the node that names it.
interface DeclaredExport {
  name: string;
  node: Node;
}

// A top-level declaration the scan may make private, with what it needs to decide.
interface PrivateExportCandidate {
  statement: Statement;
  name: Identifier;
  kind: 'type' | 'function' | 'constant';
  locallyUsed: boolean;
  needsCompiler?: boolean;
}

// The import and the re-export of one forwarded type, as the change that removes both.
interface ForwardedTypeRemoval {
  name: string;
  change: Pick<FixChange, 'line' | 'before' | 'after'>;
}

// The usage record while it is being filled in; `ModuleUsage` is what leaves this module.
interface ModuleUsageDraft {
  executable: boolean;
  reportsCliFailure: boolean;
  exports: ExportedName[];
  imports: ModuleImport[];
  reexports: ModuleReexport[];
  dynamicUnresolved: DynamicLoadSite[];
  unresolved: UnresolvedImport[];
  uncertainTypeImports: UncertainTypeImport[];
  uncertainRuntimeImports: string[];
  exportEquals: boolean;
}

function declaredExports(statement: Statement): DeclaredExport[] {
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return [];
  if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword))
    return [{ name: 'default', node: declaredName(statement) ?? statement }];
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations
      .flatMap((declaration) => bindingNames(declaration.name))
      .map((name) => ({ name: name.text, node: name }));
  const name = declaredName(statement);
  if (name && ts.isIdentifier(name)) return [{ name: name.text, node: name }];
  return [];
}

function functionSignature(declaration: SignatureDeclaration): Node[] {
  return [
    ...(declaration.typeParameters ?? []),
    ...declaration.parameters.flatMap((parameter) => (parameter.type ? [parameter.type] : [])),
    ...(declaration.type ? [declaration.type] : []),
  ];
}

function isPrivateMember(member: ClassElement): boolean {
  return (
    hasModifier(member, ts.SyntaxKind.PrivateKeyword) || Boolean(member.name && ts.isPrivateIdentifier(member.name))
  );
}

function memberSignature(member: ClassElement): Node[] {
  if (isPrivateMember(member)) return [];
  if (ts.isFunctionLike(member)) return functionSignature(member);
  if (!ts.isPropertyDeclaration(member)) return [];
  return member.type ? [member.type] : [];
}

// The parts of an exported declaration a consumer sees: its type, its parameter and return types,
// the public members and base classes of a class. A name used there is part of the export's public
// contract.
function signatureParts(statement: Statement): Node[] {
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return [statement];
  if (ts.isFunctionDeclaration(statement)) return functionSignature(statement);
  if (ts.isClassDeclaration(statement))
    return [
      ...(statement.typeParameters ?? []),
      ...(statement.heritageClauses ?? []),
      ...statement.members.flatMap(memberSignature),
    ];
  if (!ts.isVariableStatement(statement)) return [];
  return statement.declarationList.declarations.flatMap((declaration) => {
    const initializer = declaration.initializer && ts.skipOuterExpressions(declaration.initializer);
    const functionParts = initializer && ts.isFunctionLike(initializer) ? functionSignature(initializer) : [];
    return [...(declaration.type ? [declaration.type] : []), ...functionParts];
  });
}

// A type name, `typeof X`, or any reference inside a base-class expression such as `extends
// createZodDto(Schema)`.
function isContractReference(identifier: Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent) || ts.isExpressionWithTypeArguments(parent))
    return true;
  if (ts.isQualifiedName(parent)) return parent.left === identifier;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false;
  return Boolean(ts.findAncestor(identifier, ts.isHeritageClause));
}

// For each exported declaration, the other exports whose signature names it.
function signatureExposure(statements: readonly Statement[]): Map<string, Set<string>> {
  const exportNameByLocal = new Map<string, string>();
  for (const statement of statements) {
    for (const { name, node } of declaredExports(statement))
      if (ts.isIdentifier(node)) exportNameByLocal.set(node.text, name);
  }
  const exposedBy = new Map<string, Set<string>>();
  for (const statement of statements) {
    const [outer] = declaredExports(statement);
    if (!outer) continue;
    for (const part of signatureParts(statement)) {
      walkNodes(part, (node: Node) => {
        if (!ts.isIdentifier(node)) return;
        const inner = exportNameByLocal.get(node.text);
        if (!inner || inner === outer.name || !isContractReference(node)) return;
        const owners = exposedBy.get(inner) ?? new Set<string>();
        owners.add(outer.name);
        exposedBy.set(inner, owners);
      });
    }
  }
  return exposedBy;
}

const reflectionNames = new Set(['module', 'exports', 'require', 'eval', 'Function']);
const reflectionText = /\b(?:module|exports|require|eval|Function)\b|\bimport\s*\(/;

function mayReflectModule(node: Node): boolean {
  if (ts.isIdentifier(node)) return reflectionNames.has(node.text);
  if (ts.isStringTextContainingNode(node)) return reflectionText.test(node.text);
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

// Keep at least one module marker after a batch removes several exports from the same file.
function privateExportCandidates(sourceFile: SourceFile, file: string): Map<string, PrivateExportCandidate> {
  const candidates = new Map<string, PrivateExportCandidate>();
  if (sourceFile.isDeclarationFile || !/\.[cm]?tsx?$/i.test(file)) return candidates;
  const statements = sourceFile.statements;
  const hasOtherMarker = statements.some(
    (item) => ts.isImportDeclaration(item) || ts.isExportDeclaration(item) || ts.isExportAssignment(item),
  );
  const exports = statements.filter((item) => hasModifier(item, ts.SyntaxKind.ExportKeyword));
  const anchor =
    !hasOtherMarker && exports.findLast((item) => !ts.isInterfaceDeclaration(item) && !ts.isTypeAliasDeclaration(item));
  if (!hasOtherMarker && !anchor) return candidates;
  for (const statement of exports) {
    const modifierCount = ts.canHaveModifiers(statement) ? statement.modifiers?.length : undefined;
    if (statement === anchor || modifierCount !== 1) continue;
    let name: BindingName | undefined;
    let kind: PrivateExportCandidate['kind'] | undefined;
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      name = statement.name;
      kind = 'type';
    } else if (ts.isFunctionDeclaration(statement) && statement.body && !statement.asteriskToken) {
      name = statement.name;
      kind = 'function';
    } else if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
      const declarations = statement.declarationList.declarations;
      if (declarations.length !== 1 || !declarations[0].initializer || !numericConstant(declarations[0].initializer))
        continue;
      name = declarations[0].name;
      kind = 'constant';
    }
    if (name && kind && ts.isIdentifier(name)) candidates.set(name.text, { statement, name, kind, locallyUsed: false });
  }
  return candidates;
}

function ownsLines(sourceFile: SourceFile, node: Node): boolean {
  const text = sourceFile.text;
  const start = node.getStart(sourceFile);
  const lineEnd = text.indexOf('\n', node.end);
  return (
    !text.slice(text.lastIndexOf('\n', start - 1) + 1, start).trim() &&
    !text.slice(node.end, lineEnd === -1 ? text.length : lineEnd).trim() &&
    !ts.getLeadingCommentRanges(text, node.pos)?.length
  );
}

// `export type { Name };` forwarding an `import type { Name }` that nothing else in the file uses.
// Removing both is one change over the lines from the import to the re-export, so only imports may
// sit between them.
function typeReexportRemoval(sourceFile: SourceFile, statement: ExportDeclaration): ForwardedTypeRemoval | undefined {
  const clause = statement.exportClause;
  if (statement.moduleSpecifier || !clause || !ts.isNamedExports(clause) || clause.elements.length !== 1) return;
  const [element] = clause.elements;
  if (element.propertyName || !(statement.isTypeOnly || element.isTypeOnly)) return;
  const name = element.name.text;
  const statements = sourceFile.statements;
  const exportIndex = statements.indexOf(statement);
  const importIndex = statements.findIndex((item) => {
    const named = ts.isImportDeclaration(item) && item.importClause?.namedBindings;
    return named && ts.isNamedImports(named) && named.elements.some((binding) => binding.name.text === name);
  });
  const declaration = statements[importIndex];
  const importClause = declaration && ts.isImportDeclaration(declaration) ? declaration.importClause : undefined;
  // `import type` is always erased, so removing it cannot change which modules load.
  if (
    importIndex < 0 ||
    importIndex > exportIndex ||
    !importClause ||
    !importClause.isTypeOnly ||
    importClause.name ||
    !importClause.namedBindings ||
    !ts.isNamedImports(importClause.namedBindings) ||
    importClause.namedBindings.elements.length !== 1 ||
    importClause.namedBindings.elements[0].propertyName ||
    !statements.slice(importIndex + 1, exportIndex).every(ts.isImportDeclaration) ||
    !ownsLines(sourceFile, declaration) ||
    !ownsLines(sourceFile, statement)
  )
    return;
  let usedElsewhere = false;
  const inside = (node: Node, owner: Node) => node.pos >= owner.pos && node.end <= owner.end;
  walkNodes(sourceFile, (node: Node) => {
    if (ts.isIdentifier(node) && node.text === name && !inside(node, declaration) && !inside(node, statement))
      usedElsewhere = true;
  });
  // The file must stay a module once both statements are gone.
  const marker = statements.some(
    (item) =>
      item !== declaration &&
      item !== statement &&
      (ts.isImportDeclaration(item) ||
        ts.isExportDeclaration(item) ||
        ts.isExportAssignment(item) ||
        hasModifier(item, ts.SyntaxKind.ExportKeyword)),
  );
  if (usedElsewhere || !marker) return;
  const lines = sourceFile.text.split(/\r?\n/);
  const rowOf = (offset: number) => sourceFile.getLineAndCharacterOfPosition(offset).line;
  const first = rowOf(declaration.getStart(sourceFile));
  const exportRow = rowOf(statement.getStart(sourceFile));
  const removed = new Set<number>();
  for (let row = first; row <= rowOf(declaration.end); row++) removed.add(row);
  removed.add(exportRow);
  // Keep one blank line where the re-export sat between two.
  if (!lines[exportRow - 1]?.trim() && !lines[exportRow + 1]?.trim() && exportRow + 1 < lines.length)
    removed.add(exportRow + 1);
  let last = Math.max(...removed);
  // A line change needs at least one remaining line, so include the next one unchanged.
  if (last + 1 < lines.length) last++;
  const span = lines.slice(first, last + 1);
  const kept = span.filter((_line, index) => !removed.has(first + index));
  if (!kept.length) return;
  return { name, change: { line: first + 1, before: span.join('\n'), after: kept.join('\n') } };
}

// An inferred public return type can expose even a type used in a local variable (TS4053).
// An explicit return annotation bounds what escapes the function. Parameters are part of
// the signature itself, so accept them only on a private method with that same bound.
function privateTypeUse(identifier: Identifier): boolean {
  if (!ts.isTypeReferenceNode(identifier.parent) || identifier.parent.typeName !== identifier) return false;
  for (let node: Node = identifier.parent; node.parent; node = node.parent) {
    const fn = node.parent;
    if (!ts.isFunctionLike(fn)) continue;
    if (!fn.type) continue;
    if ('body' in fn && fn.body === node) return true;
    if (
      ts.isMethodDeclaration(fn) &&
      hasModifier(fn, ts.SyntaxKind.PrivateKeyword) &&
      fn.parameters.some((parameter) => parameter === node)
    )
      return true;
  }
  return false;
}

function inspectPrivateExportUse(candidates: Map<string, PrivateExportCandidate>, identifier: Identifier): void {
  const candidate = candidates.get(identifier.text);
  if (!candidate || identifier === candidate.name) return;
  const parent = identifier.parent;
  let eligible: boolean;
  if (candidate.kind === 'type') {
    eligible = ts.isTypeReferenceNode(parent) && parent.typeName === identifier;
    if (eligible && !privateTypeUse(identifier)) candidate.needsCompiler = true;
  } else if (candidate.kind === 'function') eligible = ts.isCallExpression(parent) && parent.expression === identifier;
  else
    eligible =
      ts.isTemplateSpan(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === identifier) ||
      (ts.isBinaryExpression(parent) && parent.operatorToken.kind < ts.SyntaxKind.FirstAssignment);
  if (!eligible) candidates.delete(identifier.text);
  else if (identifier.pos < candidate.statement.pos || identifier.pos >= candidate.statement.end)
    candidate.locallyUsed = true;
}

// A documented path alone is not evidence that a module is run directly.
// An immediate top-level invocation with its own process failure handler also signals a CLI.
function hasTopLevelCliFailureHandler(statement: Statement): boolean {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
  const { expression, arguments: args } = statement.expression;
  if (
    !ts.isPropertyAccessExpression(expression) ||
    expression.name.text !== 'catch' ||
    !ts.isCallExpression(expression.expression)
  )
    return false;
  const [handler] = args;
  if (!handler || !(ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) || !ts.isBlock(handler.body))
    return false;
  return handler.body.statements.some((step) => {
    if (!ts.isExpressionStatement(step) || !ts.isBinaryExpression(step.expression)) return false;
    const { left, right, operatorToken } = step.expression;
    return (
      operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isNumericLiteral(right) &&
      Number(right.text) > 0 &&
      ts.isPropertyAccessExpression(left) &&
      left.name.text === 'exitCode' &&
      ts.isIdentifier(left.expression) &&
      left.expression.text === 'process'
    );
  });
}

// A `/// <reference path>` in a declaration file loads the file it names, like an import of
// everything it exports.
function addReferencedFileImports(
  sourceFile: SourceFile,
  file: string,
  resolve: SpecifierResolver,
  usage: ModuleUsageDraft,
): void {
  for (const reference of sourceFile.referencedFiles) {
    const specifier = /^\.{0,2}\//.test(reference.fileName) ? reference.fileName : './' + reference.fileName;
    const resolved = resolve(specifier, sourceFile.fileName);
    if (resolved && resolved !== file) usage.imports.push({ to: resolved, names: 'all' });
  }
}

function collectModuleUsage(sourceFile: SourceFile, file: string, resolve: SpecifierResolver): ModuleUsage {
  const usage: ModuleUsageDraft = {
    executable: nodeShebang.test(sourceFile.text),
    reportsCliFailure: sourceFile.statements.some(hasTopLevelCliFailureHandler),
    exports: [],
    imports: [],
    reexports: [],
    dynamicUnresolved: [],
    unresolved: [],
    uncertainTypeImports: [],
    uncertainRuntimeImports: [],
    exportEquals: false,
  };

  function position(node: Node): { line: number; column: number } {
    const place = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { line: place.line + 1, column: place.character + 1 };
  }
  function resolveUsage(
    literal: StringLiteralLike,
    typeNames: ImportedNames | false,
    runtimeLoad = false,
    specifier = literal.text,
  ): string | undefined {
    let external = isBuiltin(specifier);
    const resolved = resolve(specifier, sourceFile.fileName, literal, () => {
      external = true;
    });
    if (!resolved && !external && typeNames) usage.uncertainTypeImports.push({ specifier, names: typeNames });
    if (!resolved && !external && runtimeLoad && !/\.json$/i.test(specifier))
      usage.uncertainRuntimeImports.push(specifier);
    return resolved;
  }
  // A bare specifier that did not resolve may name a workspace package whose dependencies are not
  // installed.
  function addImport(
    literal: StringLiteralLike,
    names: ImportedNames,
    importsTypes = false,
    runtimeLoad = false,
    specifier = literal.text,
  ): void {
    const resolved = resolveUsage(literal, importsTypes && names, runtimeLoad, specifier);
    if (resolved === file) return;
    if (resolved) usage.imports.push({ to: resolved, names });
    else if (!/^[./]/.test(specifier)) usage.unresolved.push({ specifier, names });
  }

  function recordExportAssignment(statement: ExportAssignment): void {
    if (statement.isExportEquals) usage.exportEquals = true;
    else usage.exports.push({ name: 'default', ...position(statement) });
  }

  function recordReexport(literal: StringLiteralLike, clause: NamedExportBindings | undefined): void {
    const names: ImportedNames =
      clause && ts.isNamedExports(clause)
        ? clause.elements.map((item) => (item.propertyName ?? item.name).text)
        : 'all';
    const to = resolveUsage(literal, names);
    if (!to || to === file) return;
    if (!clause) usage.reexports.push({ to, star: true });
    else if (ts.isNamespaceExport(clause)) usage.reexports.push({ to, namespace: clause.name.text });
    else
      usage.reexports.push({
        to,
        pairs: clause.elements.map((item) => ({
          exported: item.name.text,
          local: (item.propertyName ?? item.name).text,
        })),
      });
  }

  function recordExportDeclaration(statement: ExportDeclaration): void {
    const clause = statement.exportClause;
    if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier))
      return recordReexport(statement.moduleSpecifier, clause);
    if (!clause || !ts.isNamedExports(clause)) return;
    for (const item of clause.elements) usage.exports.push({ name: item.name.text, ...position(item.name) });
  }

  function recordImportDeclaration(statement: ImportDeclaration, literal: StringLiteralLike): void {
    const clause = statement.importClause;
    const names: string[] = [];
    const bindings = clause?.namedBindings;
    if (clause?.name) names.push('default');
    if (bindings && ts.isNamespaceImport(bindings)) names.push('all');
    else if (bindings) for (const item of bindings.elements) names.push((item.propertyName ?? item.name).text);
    addImport(literal, names.includes('all') ? 'all' : names, true);
  }

  function recordStatement(statement: Statement): void {
    if (ts.isExportAssignment(statement)) return recordExportAssignment(statement);
    if (ts.isExportDeclaration(statement)) return recordExportDeclaration(statement);
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier))
      return recordImportDeclaration(statement, statement.moduleSpecifier);
    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteralLike(statement.moduleReference.expression)
    )
      return addImport(statement.moduleReference.expression, 'all', true);
    for (const { name, node } of declaredExports(statement)) usage.exports.push({ name, ...position(node) });
  }
  for (const statement of sourceFile.statements) recordStatement(statement);
  for (const [name, owners] of signatureExposure(sourceFile.statements)) {
    for (const exported of usage.exports) if (exported.name === name) exported.exposedBy = [...owners];
  }
  const declarationByLocal = new Map<string, { name: string; statement: Statement }>();
  for (const statement of sourceFile.statements) {
    for (const { name, node } of declaredExports(statement))
      if (ts.isIdentifier(node)) declarationByLocal.set(node.text, { name, statement });
  }
  const usedInModule = new Set<string>();
  // A reference outside the exporting statement, other than a property name, means the module
  // itself needs the binding.
  function recordModuleUse(identifier: Identifier): void {
    const declaration = declarationByLocal.get(identifier.text);
    if (!declaration || (identifier.pos >= declaration.statement.pos && identifier.end <= declaration.statement.end))
      return;
    const parent = identifier.parent;
    if ('name' in parent && parent.name === identifier && !ts.isShorthandPropertyAssignment(parent)) return;
    if (ts.isExportSpecifier(parent)) return;
    usedInModule.add(declaration.name);
  }
  const candidates = privateExportCandidates(sourceFile, file);
  let reflectsModule = false;

  // Declaration files reference modules from inside `declare module` blocks, by augmentation and by
  // triple-slash path.
  function recordDeclarationReferences(node: Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      // The statement loop above already recorded the top-level ones.
      if (node.parent !== sourceFile) recordStatement(node);
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) addImport(node.name, 'all', true);
  }
  if (sourceFile.isDeclarationFile) addReferencedFileImports(sourceFile, file, resolve, usage);

  // A relative head limits the load to one folder; with no head it could reach any file, and an
  // external or aliased head is not a project path.
  function recordDynamicLoad(argument: Expression, call: CallExpression): void {
    const target = resolvedPath(argument);
    if (ts.isStringLiteralLike(target)) return addImport(target, 'all', false, true);
    if (startsInTemporaryDirectory(target)) return;
    const head = specifierHead(target);
    if (head && !head.startsWith('.')) return;
    const directory = head ? path.posix.dirname(path.posix.join(path.posix.dirname(file), head + 'x')) : undefined;
    usage.dynamicUnresolved.push({ ...position(call), directory });
  }

  const urls: UrlModule[] = [];
  function recordWorker(node: NewExpression): void {
    const url = urlModule(node);
    if (url) {
      urls.push(url);
      return;
    }
    const nodeWorker = nodeWorkerModule(node);
    // The worker runs the module without reading its exports.
    if (nodeWorker) addImport(nodeWorker.literal, [], false, false, nodeWorker.specifier);
  }
  function recordCallLoad(node: CallExpression): void {
    const loaded = metaUrlLoad(node);
    if (loaded) return addImport(loaded, 'all', false, true);
    const callee = node.expression;
    const loader =
      callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require');
    const resolver =
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'require' &&
      callee.name.text === 'resolve';
    if (!loader && !resolver) return;
    const [argument] = node.arguments;
    if (argument && ts.isStringLiteralLike(argument)) addImport(argument, 'all', false, true);
    else if (argument) recordDynamicLoad(argument, node);
  }
  function trackPrivateExportUse(node: Node): void {
    if (!reflectsModule && mayReflectModule(node)) reflectsModule = true;
    if (ts.isIdentifier(node)) inspectPrivateExportUse(candidates, node);
  }
  // Dynamic loads, workers, and import types can sit anywhere below the top level.
  walkNodes(sourceFile, (node: Node) => {
    if (ts.isIdentifier(node) && declarationByLocal.size) recordModuleUse(node);
    if (candidates.size) trackPrivateExportUse(node);
    if (!sourceFile.isDeclarationFile && ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name))
      addImport(node.name, 'all', true);
    if (sourceFile.isDeclarationFile) recordDeclarationReferences(node);
    if (ts.isNewExpression(node)) recordWorker(node);
    else if (ts.isCallExpression(node)) recordCallLoad(node);
    else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      const qualifier = node.qualifier && ts.isIdentifier(node.qualifier) ? [node.qualifier.text] : 'all';
      addImport(node.argument.literal, qualifier, true);
    }
  });
  for (const exported of usage.exports) if (usedInModule.has(exported.name)) exported.usedInModule = true;
  function recordPrivateExport(
    name: string,
    { statement, locallyUsed, kind, needsCompiler }: PrivateExportCandidate,
  ): void {
    if (!locallyUsed || (reflectsModule && kind !== 'type')) return;
    const start = statement.getStart(sourceFile);
    const { line } = sourceFile.getLineAndCharacterOfPosition(start);
    const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0);
    if (sourceFile.text.slice(lineStart, start).trim()) return;
    const nextLine = sourceFile.getLineStarts()[line + 1] ?? sourceFile.text.length;
    const before = sourceFile.text.slice(lineStart, nextLine).replace(/[\r\n]+$/, '');
    if (!/^\s*export (?:type|interface|const|function)\s/.test(before)) return;
    const exported = usage.exports.find((item) => item.name === name);
    if (!exported) return;
    exported.runtime = kind !== 'type';
    if (needsCompiler) exported.needsCompiler = true;
    exported.makePrivate = { file, line: line + 1, before, after: before.replace(/^(\s*)export /, '$1') };
  }
  for (const [name, candidate] of candidates) recordPrivateExport(name, candidate);
  function recordForwardedTypeReexports(): void {
    for (const statement of sourceFile.isDeclarationFile ? [] : sourceFile.statements) {
      const removal = ts.isExportDeclaration(statement) && typeReexportRemoval(sourceFile, statement);
      if (!removal) continue;
      const exported = usage.exports.find((item) => item.name === removal.name);
      if (!exported) continue;
      exported.makePrivate = { file, ...removal.change };
      exported.forwardsImportedType = true;
    }
  }
  function recordWorkerUrlImports(): void {
    const scopes = workerBindingScopes(sourceFile);
    for (const { urlConstructor, literals } of urls) {
      if (isShadowed(urlConstructor, scopes)) continue;
      // A worker runs the module without reading its exports.
      for (const literal of literals) addImport(literal, []);
    }
  }
  recordForwardedTypeReexports();
  if (urls.length) recordWorkerUrlImports();
  return usage;
}

export { collectModuleUsage };
