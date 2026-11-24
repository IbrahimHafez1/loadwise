// Runs every registered security check over one source file: one full syntax walk, dispatched by
// node kind.
import { loadSyntax } from '../performance/compiler.cjs';
import { typeFromPackage } from '../performance/package-types.cjs';
import { reviewedReason, reviewMarkers, repeatedReviewContext } from '../performance/review-context.cjs';
import { movedRules } from './rule-ids.cjs';
import { libraryCall } from './bindings.cjs';
import { createFileContext } from './file-context.cjs';
import { createTaint } from './taint/index.cjs';
import { hotPathOf } from '../shared/hot-path.cjs';
import type { CallExpression, NewExpression, Node, SourceFile } from 'typescript';
import type {
  Finding,
  LibraryCall,
  ProgramAdapter,
  ReportDetails,
  RulePolicy,
  SecurityRuleContext,
  TaintApi,
} from '../shared/types.cjs';
import type { SecurityCheck, SecurityCheckModule } from './types/security-check.cjs';
const ts = loadSyntax();

// Each module exports { checks: { <ts.SyntaxKind name>: [(node, context) => void] } }. A rule group
// adds its checks to its own index.cjs; a new group is added to this list.
const registeredModules: readonly SecurityCheckModule[] = [
  require('./pg-dynamic-query.cjs'),
  require('./scope/query-policy.cjs'),
  require('./scope/drizzle-policy.cjs'),
  require('./injection/index.cjs'),
  require('./request-forgery/index.cjs'),
  require('./auth-crypto/index.cjs'),
  require('./exposure/index.cjs'),
];
// The moved rules keep the review reasons they had as performance rules (seed, benchmark and
// tooling sources).
const movedRuleIds = new Set(movedRules);

function isSyntaxKindName(name: string): name is keyof typeof ts.SyntaxKind {
  return name in ts.SyntaxKind;
}

function checksByKind(modules: readonly SecurityCheckModule[]): Map<number, SecurityCheck[]> {
  const byKind = new Map<number, SecurityCheck[]>();
  for (const { checks } of modules) {
    for (const [kindName, kindChecks] of Object.entries(checks)) {
      const kind = isSyntaxKindName(kindName) ? ts.SyntaxKind[kindName] : undefined;
      if (typeof kind !== 'number') throw new Error('Unknown syntax kind in security checks: ' + kindName);
      byKind.set(kind, [...(byKind.get(kind) ?? []), ...kindChecks]);
    }
  }
  return byKind;
}

// A finding as the analyzer builds it: the position is always known.
interface LocatedFinding extends Finding {
  file: string;
  line: number;
  column: number;
}

// analyzeFile(program, sourceFile, policy) for the given modules; tests pass their own probe
// modules.
function createAnalyzer(modules: readonly SecurityCheckModule[]) {
  const dispatch = checksByKind(modules);
  return function analyzeFile(program: ProgramAdapter, sourceFile: SourceFile, policy?: RulePolicy): LocatedFinding[] {
    const checker = program.getTypeChecker();
    const findings: LocatedFinding[] = [];
    const reported = new Set<string>();
    const hasReviewComments = reviewMarkers.some((marker) => sourceFile.text.includes(marker));
    const fileContext = createFileContext(sourceFile);
    let taint: TaintApi | undefined;
    const libraryCalls = new WeakMap<CallExpression | NewExpression, LibraryCall | undefined>();
    const context: SecurityRuleContext = {
      program,
      checker,
      sourceFile,
      policy,
      fileContext,
      strictNullChecks: policy
        ? Boolean(program.getCompilerOptions().strictNullChecks ?? program.getCompilerOptions().strict)
        : false,
      isPackageType: (node: Node, packages: readonly string[], typeNames?: readonly string[]) =>
        typeFromPackage(checker.getTypeAtLocation(node), packages, typeNames),
      // Many checks ask about the same call, and the type tier behind the answer is the costly part
      // of a scan.
      libraryCall(call: CallExpression | NewExpression) {
        if (!libraryCalls.has(call)) libraryCalls.set(call, libraryCall(call, context));
        return libraryCalls.get(call);
      },
      // Built on first use: most files have no sink.
      get taint() {
        return (taint ??= createTaint(program));
      },
      // details.taint (a trace result) becomes finding.trace; other details are copied onto the
      // finding.
      report(node: Node, ruleId: string, message: string, contextualReason?: string, details?: ReportDetails) {
        const start = node.getStart(sourceFile);
        const key = start + ':' + ruleId;
        if (reported.has(key)) return;
        reported.add(key);
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
        const reason =
          (hasReviewComments && reviewedReason(sourceFile, line, ruleId)) ||
          contextualReason ||
          (movedRuleIds.has(ruleId)
            ? repeatedReviewContext(node, ruleId, checker, sourceFile)
            : fileContext.testSourceReason);
        const finding: LocatedFinding = {
          file: sourceFile.fileName,
          line: line + 1,
          column: character + 1,
          ruleId,
          message,
        };
        if (reason) finding.contextualReason = reason;
        const { taint: traced, ...rest }: ReportDetails = details ?? {};
        Object.assign(finding, rest);
        if (traced) finding.trace = traced.steps;
        finding.hotPath = hotPathOf(node, program);
        findings.push(finding);
      },
    };
    (function visit(node: Node): void {
      const checks = dispatch.get(node.kind);
      if (checks) for (const check of checks) check(node, context);
      ts.forEachChild(node, visit);
    })(sourceFile);
    return findings.sort(
      (left, right) => left.line - right.line || left.column - right.column || left.ruleId.localeCompare(right.ruleId),
    );
  };
}

export const analyzeFile = createAnalyzer(registeredModules);
export { createAnalyzer };
