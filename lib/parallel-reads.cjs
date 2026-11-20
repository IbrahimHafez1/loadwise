'use strict';

const compiler = require('./compiler.cjs');
const { scopeEvidence, stableModuleName } = require('./query-policy.cjs');
const importsConfiguredReads = new WeakMap();

function validateParallelReads(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new Error('parallelReads requires a nonempty array of read groups.');
  const modules = new Map();
  for (const group of raw) {
    if (
      !group ||
      Object.keys(group).sort().join(',') !== 'exports,from' ||
      !stableModuleName(group.from) ||
      !Array.isArray(group.exports) ||
      group.exports.length < 2 ||
      new Set(group.exports).size !== group.exports.length ||
      !Array.from(group.exports).every((name) => typeof name === 'string' && /^[A-Za-z_$][\w$]*$/.test(name))
    ) {
      throw new Error(
        'Each parallelReads group requires a stable module name and at least two distinct named exports.',
      );
    }
    if (!modules.has(group.from)) modules.set(group.from, new Map());
    const exports = modules.get(group.from);
    for (const name of group.exports) {
      if (!exports.has(name)) exports.set(name, new Set());
      exports.get(name).add(group);
    }
  }
  return modules;
}

function readContext(block, ts) {
  if (ts.isSourceFile(block)) return true;
  const owner = block.parent;
  if (
    owner.body !== block ||
    owner.asteriskToken ||
    !owner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  )
    return false;
  if (
    owner.parameters?.some(
      (parameter) => !ts.isIdentifier(parameter.name) || (parameter.initializer && !literal(parameter.initializer, ts)),
    )
  )
    return false;
  if (ts.isFunctionDeclaration(owner)) return ts.isSourceFile(owner.parent);
  if (ts.isMethodDeclaration(owner)) return ts.isClassDeclaration(owner.parent) && ts.isSourceFile(owner.parent.parent);
  if (!ts.isArrowFunction(owner) && !ts.isFunctionExpression(owner)) return false;
  const binding = owner.parent;
  return (
    ts.isVariableDeclaration(binding) &&
    binding.parent.flags & ts.NodeFlags.Const &&
    ts.isVariableStatement(binding.parent.parent) &&
    ts.isSourceFile(binding.parent.parent.parent)
  );
}

function literal(node, ts) {
  return (
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.BigIntLiteral ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

function stableArgument(node, block, checker, ts, evidence) {
  node = evidence.plain(node);
  if (literal(node, ts)) return true;
  if (!ts.isIdentifier(node)) return false;
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  if (!declaration) return false;
  const parameter = ts.isParameter(declaration) && declaration.parent === block.parent;
  const constant = ts.isVariableDeclaration(declaration) && Boolean(declaration.parent.flags & ts.NodeFlags.Const);
  return (parameter || constant) && evidence.scalar(checker.getTypeAtLocation(node), true);
}

function configuredRead(call, block, checker, groups, ts) {
  const evidence = scopeEvidence();
  call = evidence.plain(call);
  if (!ts.isCallExpression(call) || ts.isOptionalChain(call)) return;
  const target = evidence.plain(call.expression);
  const member = evidence.importedMember(target, checker);
  const contracts = member && groups.get(member.from)?.get(member.exported);
  if (!contracts || !call.arguments.every((arg) => stableArgument(arg, block, checker, ts, evidence))) return;
  const returned = checker.getTypeAtLocation(call).getSymbol();
  if (
    returned?.name !== 'Promise' ||
    !returned.declarations?.some((decl) => compiler.isDefaultLibrary(checker, decl.getSourceFile()))
  )
    return;
  const binding = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(target) ? target.name : target);
  const symbol = binding?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(binding) : binding;
  if (symbol?.valueDeclaration)
    return {
      contracts,
      symbol,
      arguments: call.arguments.map((arg) => evidence.plain(arg)),
      exported: member.exported,
    };
}

function checkParallelReads(block, context, groups) {
  const ts = compiler.syntax;
  // Files without a configured import need no per-block semantic queries.
  if (!importsConfiguredReads.has(context)) {
    importsConfiguredReads.set(
      context,
      block
        .getSourceFile()
        .statements.some(
          (statement) => ts.isImportDeclaration(statement) && groups.has(statement.moduleSpecifier.text),
        ),
    );
  }
  if (!importsConfiguredReads.get(context)) return;
  if (block.statements.length < 2 || !readContext(block, ts)) return;
  let previous;
  for (const statement of block.statements) {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
    ) {
      previous = undefined;
      continue;
    }
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const) ||
      statement.declarationList.declarations.length !== 1
    )
      return;
    const declaration = statement.declarationList.declarations[0];
    const value = declaration.initializer;
    if (!value || !ts.isIdentifier(declaration.name)) return;
    if (literal(value, ts)) {
      previous = undefined;
      continue;
    }
    // An opaque earlier operation may have opened a transaction or acquired a resource.
    if (!ts.isAwaitExpression(value)) return;
    const read = configuredRead(value.expression, block, context.checker, groups, ts);
    if (!read) return;
    if (
      previous &&
      previous.symbol !== read.symbol &&
      [...read.contracts].some((group) => previous.contracts.has(group)) &&
      !read.arguments.some((arg) => ts.isIdentifier(arg) && arg.text === previous.name)
    ) {
      context.report(
        value,
        'known-reads-awaited-serially',
        'Project policy allows ' +
          previous.exported +
          '() and ' +
          read.exported +
          '() to start together. Consider Promise.all() for this pair.',
      );
      // Pairwise contracts can overlap without permitting a three-way start.
      previous = undefined;
      continue;
    }
    previous = { ...read, name: declaration.name.text };
  }
}

module.exports = { validateParallelReads, checkParallelReads };
