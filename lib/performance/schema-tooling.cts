import fs from 'node:fs';
import path from 'node:path';
import { loadSyntax } from './compiler.cjs';
import { noteUnreadable } from '../shared/coverage-notes.cjs';
import { findProjectRoot } from './schema/context.cjs';
import type { Expression, FunctionDeclaration, Identifier, Node, SourceFile, Statement } from 'typescript';
import type { CheckerAdapter, ProgramAdapter } from '../shared/types.cjs';
const ts = loadSyntax();

/** What the tooling check reads from package.json. */
interface PackageManifest {
  private?: boolean;
  exports?: unknown;
  scripts?: Record<string, unknown>;
}

type NamedFunction = FunctionDeclaration & { name: Identifier };

/**
 * Per project: schema-mode flags of each package, each folder's project root, and the verdict per
 * function.
 */
interface SchemaToolingState {
  packageModes: Map<string, Set<string>>;
  rootByDirectory: Map<string, string>;
  entryUses: Map<Node, boolean>;
}

interface ToolingUseInput {
  owner: NamedFunction;
  root: string;
  modes: ReadonlySet<string>;
  program: ProgramAdapter;
  checker: CheckerAdapter;
  state: SchemaToolingState;
}

const schemaFlag = /^GENERATE_(?:[A-Z0-9]+_)*SCHEMA$/;
const schemaModeInScript = /(?:^|\s)(GENERATE_(?:[A-Z0-9]+_)*SCHEMA)=(?:true|'true'|"true")(?=\s|$)/g;
const dynamicModuleAccess = /\b(?:require|import)\s*\(/;
const fullProjects = new WeakMap<ProgramAdapter, SchemaToolingState>();

// A partial file list or one member of a project-reference graph cannot prove that all uses are
// tooling calls.
function enableSchemaTooling(program: ProgramAdapter): void {
  fullProjects.set(program, { packageModes: new Map(), rootByDirectory: new Map(), entryUses: new Map() });
}

function rootFor(source: SourceFile, state: SchemaToolingState): string {
  const directory = path.dirname(source.fileName);
  const known = state.rootByDirectory.get(directory);
  if (known !== undefined) return known;
  const root = findProjectRoot(directory);
  state.rootByDirectory.set(directory, root);
  return root;
}

function configuredModes(root: string, state: SchemaToolingState): ReadonlySet<string> {
  const known = state.packageModes.get(root);
  if (known) return known;
  const modes = new Set<string>();
  try {
    const manifest: PackageManifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (manifest.private === true && manifest.exports == null) {
      for (const script of Object.values(manifest.scripts ?? {})) {
        if (typeof script !== 'string') continue;
        for (const [, flag] of script.matchAll(schemaModeInScript)) modes.add(flag);
      }
    }
  } catch (error) {
    // A package without a readable tooling declaration keeps normal advisories; only a missing file
    // is expected.
    noteUnreadable({
      error,
      location: path.join(root, 'package.json'),
      consequence: 'kept normal advisories for that package',
    });
  }
  state.packageModes.set(root, modes);
  return modes;
}

function unwrap(node: Expression): Expression {
  return node && ts.skipOuterExpressions(node);
}

function envMode(condition: Expression, checker: CheckerAdapter): { flag: string; negative: boolean } | undefined {
  const test = unwrap(condition);
  const negative = ts.isPrefixUnaryExpression(test) && test.operator === ts.SyntaxKind.ExclamationToken;
  const access = negative ? unwrap(test.operand) : test;
  if (!ts.isPropertyAccessExpression(access) || access.questionDotToken || !schemaFlag.test(access.name.text)) return;
  const env = access.expression;
  if (
    !ts.isPropertyAccessExpression(env) ||
    env.questionDotToken ||
    env.name.text !== 'env' ||
    !ts.isIdentifier(env.expression) ||
    env.expression.text !== 'process'
  )
    return;
  const declarations = checker.getSymbolAtLocation(env.expression)?.declarations ?? [];
  if (declarations.some((declaration: Node) => !declaration.getSourceFile().isDeclarationFile)) return;
  return { flag: access.name.text, negative };
}

function branchCallee(branch: Statement): Identifier | undefined {
  if (ts.isBlock(branch)) {
    if (branch.statements.length !== 1) return;
    branch = branch.statements[0];
  }
  if (!ts.isExpressionStatement(branch)) return;
  let call = unwrap(branch.expression);
  if (ts.isAwaitExpression(call) || ts.isVoidExpression(call)) call = unwrap(call.expression);
  if (ts.isCallExpression(call) && !call.questionDotToken && ts.isIdentifier(call.expression)) return call.expression;
}

function resolveDeclaration(identifier: Identifier, checker: CheckerAdapter): Node | undefined {
  const parent = identifier.parent;
  let symbol =
    ts.isShorthandPropertyAssignment(parent) && parent.name === identifier
      ? checker.getShorthandAssignmentValueSymbol(parent)
      : checker.getSymbolAtLocation(identifier);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.valueDeclaration;
}

function accessesModuleDynamically(source: SourceFile): boolean {
  if (!dynamicModuleAccess.test(source.text)) return false;
  function find(node: Node): true | undefined {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require'))
        return true;
    }
    return ts.forEachChild(node, find);
  }
  return ts.forEachChild(source, find) === true;
}

function usesOnlyKnownCalls(
  owner: NamedFunction,
  calls: ReadonlySet<Identifier>,
  source: SourceFile,
  checker: CheckerAdapter,
): boolean {
  const ownerSource = owner.getSourceFile();
  const names = new Set<string>([owner.name.text]);
  const bindings = new Set<Node>([owner.name, ...calls]);
  for (const statement of source.statements) {
    if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || !statement.moduleSpecifier)
      continue;
    const referencesOwner = checker.getSymbolAtLocation(statement.moduleSpecifier)?.declarations?.includes(ownerSource);
    if (!referencesOwner) continue;
    if (ts.isExportDeclaration(statement)) return false;
    const defaultName = statement.importClause?.name;
    if (defaultName && resolveDeclaration(defaultName, checker) === owner) return false;
    const named = statement.importClause?.namedBindings;
    if (!named) continue;
    if (!ts.isNamedImports(named)) return false;
    for (const specifier of named.elements) {
      if (specifier.isTypeOnly || resolveDeclaration(specifier.name, checker) !== owner) continue;
      names.add(specifier.name.text);
      bindings.add(specifier.name);
      if (specifier.propertyName) bindings.add(specifier.propertyName);
    }
  }

  function escape(node: Node): true | undefined {
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) return true;
    if (
      ts.isIdentifier(node) &&
      names.has(node.text) &&
      !bindings.has(node) &&
      resolveDeclaration(node, checker) === owner
    )
      return true;
    return ts.forEachChild(node, escape);
  }
  return !ts.forEachChild(source, escape);
}

function findToolingUse({ owner, root, modes, program, checker, state }: ToolingUseInput): boolean {
  const allFiles = program.getToolingSourceFiles?.() ?? program.getSourceFiles?.() ?? [];
  const files = allFiles.filter(
    (source) => !source.isDeclarationFile && !/[/\\]node_modules[/\\]/.test(source.fileName),
  );
  const calls = new Set<Identifier>();
  for (const source of files) {
    if (!source.text.includes('GENERATE_') || rootFor(source, state) !== root) continue;
    const entryStatements = source.statements.filter(
      (statement: Statement) =>
        !ts.isImportDeclaration(statement) &&
        !ts.isFunctionDeclaration(statement) &&
        !ts.isTypeAliasDeclaration(statement) &&
        !ts.isInterfaceDeclaration(statement),
    );
    if (entryStatements.length !== 1) continue;
    const [entry] = entryStatements;
    if (!ts.isIfStatement(entry) || !entry.elseStatement) continue;
    const mode = envMode(entry.expression, checker);
    if (!mode || !modes.has(mode.flag)) continue;
    const tooling = branchCallee(mode.negative ? entry.elseStatement : entry.thenStatement);
    const runtime = branchCallee(mode.negative ? entry.thenStatement : entry.elseStatement);
    if (tooling && runtime && resolveDeclaration(tooling, checker) === owner) calls.add(tooling);
  }
  return (
    calls.size > 0 &&
    files.every((source) => !accessesModuleDynamically(source) && usesOnlyKnownCalls(owner, calls, source, checker))
  );
}

function isNamedFunction(node: Node): node is NamedFunction {
  return ts.isFunctionDeclaration(node) && node.name !== undefined;
}

function runsOnlyInSchemaTooling(owner: Node, program: ProgramAdapter, checker: CheckerAdapter): boolean {
  const state = fullProjects.get(program);
  if (!state || !isNamedFunction(owner) || !ts.isSourceFile(owner.parent)) return false;
  const known = state.entryUses.get(owner);
  if (known !== undefined) return known;
  const root = rootFor(owner.parent, state);
  const modes = configuredModes(root, state);
  const result = modes.size > 0 && findToolingUse({ owner, root, modes, program, checker, state });
  state.entryUses.set(owner, result);
  return result;
}

export { enableSchemaTooling, runsOnlyInSchemaTooling };
