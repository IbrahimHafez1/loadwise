import * as compiler from './compiler.js';
import { validateParallelReads } from './parallel-reads-policy.js';
import { scopeEvidence } from './scope-evidence.js';
import type {
  ArrowFunction,
  Block,
  Expression,
  FunctionDeclaration,
  FunctionExpression,
  MethodDeclaration,
  Node,
  SourceFile,
} from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext, SymbolAdapter } from '../shared/types.js';
import type { ParallelReadGroup, ParallelReadGroups } from './types/parallel-reads.js';
import type * as TypeScript from 'typescript';

type Syntax = typeof TypeScript;
type ScopeEvidence = ReturnType<typeof scopeEvidence>;

// The statements that hold the reads: a module or the body of an async function.
type ReadBlock = Block | SourceFile;

// A function that can own a block of reads.
type ReadOwner = FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression;

// An awaited call to a configured read, with the contracts that name it.
interface ConfiguredRead {
  contracts: Set<ParallelReadGroup>;
  symbol: SymbolAdapter;
  arguments: Expression[];
  exported: string;
}

const importsConfiguredReads = new WeakMap<PerformanceRuleContext, boolean>();

function isReadOwner(node: Node, ts: Syntax): node is ReadOwner {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  );
}

function readContext(block: ReadBlock, ts: Syntax): boolean {
  if (ts.isSourceFile(block)) return true;
  const owner = block.parent;
  if (
    !isReadOwner(owner, ts) ||
    owner.body !== block ||
    ('asteriskToken' in owner && owner.asteriskToken) ||
    !owner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  )
    return false;
  if (
    owner.parameters.some(
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
    !!(binding.parent.flags & ts.NodeFlags.Const) &&
    ts.isVariableStatement(binding.parent.parent) &&
    ts.isSourceFile(binding.parent.parent.parent)
  );
}

function literal(node: Node, ts: Syntax): boolean {
  return (
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.BigIntLiteral ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

function stableArgument(
  node: Node,
  block: ReadBlock,
  checker: CheckerAdapter,
  ts: Syntax,
  evidence: ScopeEvidence,
): boolean {
  node = evidence.plain(node);
  if (literal(node, ts)) return true;
  if (!ts.isIdentifier(node)) return false;
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  if (!declaration) return false;
  const parameter = ts.isParameter(declaration) && declaration.parent === block.parent;
  const constant = ts.isVariableDeclaration(declaration) && Boolean(declaration.parent.flags & ts.NodeFlags.Const);
  return (parameter || constant) && evidence.scalar(checker.getTypeAtLocation(node), true);
}

function configuredRead(
  call: Expression,
  block: ReadBlock,
  checker: CheckerAdapter,
  groups: ParallelReadGroups,
  ts: Syntax,
): ConfiguredRead | undefined {
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
  const symbol = binding && binding.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(binding) : binding;
  if (symbol?.valueDeclaration && member)
    return {
      contracts,
      symbol,
      arguments: call.arguments.map((arg) => evidence.plain(arg)),
      exported: member.exported,
    };
}

function checkParallelReads(block: ReadBlock, context: PerformanceRuleContext, groups: ParallelReadGroups) {
  const ts = compiler.loadSyntax();
  // Files without a configured import need no per-block semantic queries.
  if (!importsConfiguredReads.has(context)) {
    importsConfiguredReads.set(
      context,
      block
        .getSourceFile()
        .statements.some(
          (statement) =>
            ts.isImportDeclaration(statement) &&
            ts.isStringLiteral(statement.moduleSpecifier) &&
            groups.has(statement.moduleSpecifier.text),
        ),
    );
  }
  if (!importsConfiguredReads.get(context)) return;
  if (block.statements.length < 2 || !readContext(block, ts)) return;
  let previous: (ConfiguredRead & { name: string }) | undefined;
  for (const statement of block.statements) {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      (ts.canHaveModifiers(statement) &&
        ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword))
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
    const earlier = previous;
    if (
      earlier &&
      earlier.symbol !== read.symbol &&
      [...read.contracts].some((group) => earlier.contracts.has(group)) &&
      !read.arguments.some((arg) => ts.isIdentifier(arg) && arg.text === earlier.name)
    ) {
      context.report(
        value,
        'known-reads-awaited-serially',
        'Project policy allows ' +
          earlier.exported +
          '() and ' +
          read.exported +
          '() to start together, but they are awaited one after the other. Use `Promise.all([a(), b()])` for this pair.',
      );
      // Pairwise contracts can overlap without permitting a three-way start.
      previous = undefined;
      continue;
    }
    previous = { ...read, name: declaration.name.text };
  }
}

export { validateParallelReads, checkParallelReads };
