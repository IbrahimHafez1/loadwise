// Runs every registered security check over one source file: one full syntax walk, dispatched by
// node kind.
import { ts } from '../performance/compiler.js';
import { typeFromPackage } from '../performance/package-types.js';
import { reviewedReason, reviewMarkers, repeatedReviewContext } from '../performance/review-context.js';
import { movedRules } from './rule-ids.js';
import { libraryCall } from './bindings.js';
import { createFileContext } from './file-context.js';
import { createTaint } from './taint/index.js';
import { hotPathOf } from '../shared/hot-path-graph.js';
import * as pgDynamicQuery from './pg-dynamic-query.js';
import * as queryPolicy from './scope/query-policy.js';
import * as drizzlePolicy from './scope/drizzle-policy.js';
import * as injection from './injection/index.js';
import * as requestForgery from './request-forgery/index.js';
import * as authCrypto from './auth-crypto/index.js';
import * as exposure from './exposure/index.js';
import * as phase5Rules from './phase5-rules.js';
import type { CallExpression, NewExpression, Node, SourceFile } from 'typescript';
import type {
  Finding,
  LibraryCall,
  ProgramAdapter,
  ReportDetails,
  RulePolicy,
  SecurityRuleContext,
  TaintApi,
  TypeAdapter,
} from '../shared/types.js';
import type { SecurityCheck, SecurityCheckModule } from './types/security-check.js';

// Each module exports { checks: { <ts.SyntaxKind name>: [(node, context) => void] } }. A rule group
// adds its checks to its own index.cjs; a new group is added to this list.
const registeredModules: readonly SecurityCheckModule[] = [
  pgDynamicQuery,
  queryPolicy,
  drizzlePolicy,
  injection,
  requestForgery,
  authCrypto,
  exposure,
  phase5Rules,
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
  let builtFor: typeof ts.SyntaxKind = ts.SyntaxKind;
  let dispatch = checksByKind(modules);
  return function analyzeFile(program: ProgramAdapter, sourceFile: SourceFile, policy?: RulePolicy): LocatedFinding[] {
    if (builtFor !== ts.SyntaxKind) {
      dispatch = checksByKind(modules);
      builtFor = ts.SyntaxKind;
    }
    const checker = program.getTypeChecker();
    const findings: LocatedFinding[] = [];
    const reported = new Set<string>();
    let hasReviewComments: boolean | undefined;
    const fileContext = createFileContext(sourceFile);
    let taint: TaintApi | undefined;
    const libraryCalls = new WeakMap<CallExpression | NewExpression, LibraryCall | undefined>();
    const nodeTypes = new WeakMap<Node, TypeAdapter>();
    const compilerOptions = policy ? program.getCompilerOptions() : undefined;
    const context: SecurityRuleContext = {
      program,
      checker,
      sourceFile,
      policy,
      fileContext,
      strictNullChecks: compilerOptions ? Boolean(compilerOptions.strictNullChecks ?? compilerOptions.strict) : false,
      isPackageType(node: Node, packages: readonly string[], typeNames?: readonly string[]) {
        let type = nodeTypes.get(node);
        if (type === undefined) {
          type = checker.getTypeAtLocation(node);
          nodeTypes.set(node, type);
        }
        return typeFromPackage(type, packages, typeNames);
      },
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
        hasReviewComments ??= reviewMarkers.some((marker) => sourceFile.text.includes(marker));
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
