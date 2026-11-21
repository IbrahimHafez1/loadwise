'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { syntax: ts } = require('./compiler.cjs');
const { findProjectRoot } = require('./schema/context.cjs');

const schemaFlag = /^GENERATE_(?:[A-Z0-9]+_)*SCHEMA$/;
const schemaModeInScript = /(?:^|\s)(GENERATE_(?:[A-Z0-9]+_)*SCHEMA)=(?:true|'true'|"true")(?=\s|$)/g;
const dynamicModuleAccess = /\b(?:require|import)\s*\(/;
const fullProjects = new WeakMap();

// A partial file list or one member of a project-reference graph cannot prove that all uses are tooling calls.
function enableSchemaTooling(program) {
  fullProjects.set(program, { packageModes: new Map(), rootByDirectory: new Map(), entryUses: new Map() });
}

function rootFor(source, state) {
  const directory = path.dirname(source.fileName);
  if (!state.rootByDirectory.has(directory)) state.rootByDirectory.set(directory, findProjectRoot(directory));
  return state.rootByDirectory.get(directory);
}

function configuredModes(root, state) {
  if (state.packageModes.has(root)) return state.packageModes.get(root);
  const modes = new Set();
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (manifest.private === true && manifest.exports == null) {
      for (const script of Object.values(manifest.scripts ?? {})) {
        if (typeof script !== 'string') continue;
        for (const [, flag] of script.matchAll(schemaModeInScript)) modes.add(flag);
      }
    }
  } catch {
    // A package without a readable tooling declaration keeps normal advisories.
  }
  state.packageModes.set(root, modes);
  return modes;
}

function unwrap(node) {
  return node && ts.skipOuterExpressions(node);
}

function envMode(condition, checker) {
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
  if (declarations.some((declaration) => !declaration.getSourceFile().isDeclarationFile)) return;
  return { flag: access.name.text, negative };
}

function branchCallee(branch) {
  if (ts.isBlock(branch)) {
    if (branch.statements.length !== 1) return;
    branch = branch.statements[0];
  }
  if (!ts.isExpressionStatement(branch)) return;
  let call = unwrap(branch.expression);
  if (ts.isAwaitExpression(call) || ts.isVoidExpression(call)) call = unwrap(call.expression);
  if (ts.isCallExpression(call) && !call.questionDotToken && ts.isIdentifier(call.expression)) return call.expression;
}

function resolveDeclaration(identifier, checker) {
  const parent = identifier.parent;
  let symbol =
    ts.isShorthandPropertyAssignment(parent) && parent.name === identifier
      ? checker.getShorthandAssignmentValueSymbol(parent)
      : checker.getSymbolAtLocation(identifier);
  if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.valueDeclaration;
}

function accessesModuleDynamically(source) {
  if (!dynamicModuleAccess.test(source.text)) return false;
  function find(node) {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require'))
        return true;
    }
    return ts.forEachChild(node, find);
  }
  return ts.forEachChild(source, find);
}

function usesOnlyKnownCalls(owner, calls, source, checker) {
  const ownerSource = owner.getSourceFile();
  const names = new Set([owner.name.text]);
  const bindings = new Set([owner.name, ...calls]);
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

  function escape(node) {
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

function findToolingUse({ owner, root, modes, program, checker, state }) {
  const allFiles = program.getToolingSourceFiles?.() ?? program.getSourceFiles();
  const files = allFiles.filter(
    (source) => !source.isDeclarationFile && !/[/\\]node_modules[/\\]/.test(source.fileName),
  );
  const calls = new Set();
  for (const source of files) {
    if (!source.text.includes('GENERATE_') || rootFor(source, state) !== root) continue;
    const entryStatements = source.statements.filter(
      (statement) =>
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

function runsOnlyInSchemaTooling(owner, program, checker) {
  const state = fullProjects.get(program);
  if (!state || !ts.isFunctionDeclaration(owner) || !owner.name || !ts.isSourceFile(owner.parent)) return false;
  if (state.entryUses.has(owner)) return state.entryUses.get(owner);
  const root = rootFor(owner.parent, state);
  const modes = configuredModes(root, state);
  const result = modes.size > 0 && findToolingUse({ owner, root, modes, program, checker, state });
  state.entryUses.set(owner, result);
  return result;
}

module.exports = { enableSchemaTooling, runsOnlyInSchemaTooling };
