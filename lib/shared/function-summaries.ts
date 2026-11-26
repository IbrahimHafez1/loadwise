// Interprocedural summaries of project functions, shared by the security and performance rules.
//
//   const summaries = functionSummaries(program);
//   summaries.summaryOf(declaration)  -> FunctionSummary, or undefined for a function outside the project or without a body
//   summaries.summaryOfCall(call)     -> the FunctionSummary of the project function a call resolves to, or undefined
//   summaries.calleeOf(call)          -> that function's declaration, or undefined
//
//   FunctionSummary {
//     validates: [{ parameterIndex, kind: 'url' | 'path' | 'id', mode }]
//       mode 'throws':  returns normally only when the argument is valid (it throws or exits otherwise);
//            'boolean': returns true only when the argument is valid;
//            'returns': returns the validated argument, or a value derived from it, or a literal fallback.
//       Each kind is what the matching sink recogniser accepts: url = isRelativeRedirect / isAllowedHost (open-redirect),
//       path = isContainedPath (path-traversal), id = a pinning guard (guards.cjs) or an ObjectId / UUID check.
//     queries:  [{ kind: 'db' | 'redis' | 'queue' | 'http', family, label, file, line, column, via }]
//     blocking: [{ kind: 'fs' | 'zlib' | 'crypto' | 'child_process' | 'password-hash', label, file, line, column, via }]
//     returnsRequestData: { parameterIndex, path } when a return value reads request input from that parameter
//       (`path` such as 'query.next'; empty for a whole Nest `@Body()` value), otherwise undefined
//     complete: false when the call depth bound left project functions that do work unvisited
//   }
//   Under the native engine `validates` is [] and `returnsRequestData` undefined: the security helpers they reuse
//   need the TypeScript compiler's syntax and checker, as the security checker itself does.
//   `via` names the project functions between this one and the effect, outermost first; [] means a direct call.
//
// Each field is computed on first read and memoised per program and declaration. Queries and blocking calls follow
// project calls breadth first up to MAX_CALL_DEPTH, so a cycle is visited once. Validation and request data follow
// calls recursively; a function still being summarised counts as validating and returning nothing.
// Database, Redis and queue calls are service-query-in-loop's (service-loops.cjs), HTTP calls http-call-without-timeout's,
// blocking calls node-sync-*'s and password-hash-sync-in-async's, so a rule adopting this keeps its own findings.
import { ts } from '../performance/compiler.js';
import {
  endOfBodySink,
  fallsThrough,
  forEachOwnNode,
  functionLabel,
  isBooleanLiteral,
  isConst,
  isLiteralValue,
  isProjectFunction,
  returnStatements,
  valueLeaves,
  whenTrueSink,
} from './function-syntax.js';
import { calleeName } from '../performance/call-syntax.js';
import { location } from '../performance/schema/ts-helpers.js';
import { runsWithBody, signatureDeclaration, summarize } from '../performance/service-loops.js';
import { blockingBinding } from '../performance/node-fs.js';
import { asyncReplacements, isBcryptCall } from '../performance/password-hashing.js';
import { describeCall, isDefaultAxios, isGlobalFetch } from '../performance/http-timeouts.js';
import { typeFromPackage } from '../performance/package-types.js';
import { libraryCall } from '../security/bindings.js';
import { isContainedPath, isAllowedHost, isRelativeRedirect, strip } from '../security/request-forgery/shared.js';
import { isGuardedByCondition, isGuardedUse } from '../security/taint/guards.js';
import { parameterSource } from '../security/taint/sources.js';
import { isUrlConstructor } from '../security/taint/url-parts.js';
import type { CallExpression, Expression, Identifier, Node, ParameterDeclaration, Statement } from 'typescript';
import type {
  FileContext,
  LibraryCall,
  ProgramAdapter,
  RuleContext,
  SecurityRuleContext,
  SymbolAdapter,
  TaintApi,
} from './types.js';
import type {
  BlockingFact,
  EffectSite,
  FunctionSummaries,
  FunctionSummary,
  FunctionWithBody,
  QueryFact,
  Reached,
  RequestData,
  Validation,
  ValidationKind,
  ValidationMode,
} from './types/function-summaries.js';

/** The rule context the recognisers get, with the library lookup they share. */
type SummaryContext = RuleContext & { taint: TaintApi; libraryCall(call: CallExpression): LibraryCall | undefined };

// The recognisers are asked about a function's own code, so the facts about "the file under
// analysis" are neutral.
const noFileContext: FileContext = {
  isTestSource: false,
  testSourceReason: undefined,
  underNonProductionGuard: () => false,
};

/** A function reached from the root, with the project functions between them. */
interface FrontierEntry {
  declaration: FunctionWithBody;
  via: string[];
}

/**
 * What a function does by itself: its calls to databases, blocking calls, and the project functions
 * it calls.
 */
interface OwnFacts {
  queries: QueryFact[];
  blocking: BlockingFact[];
  callees: FunctionWithBody[];
}

interface ReachedEffects {
  queries: Reached<QueryFact>[];
  blocking: Reached<BlockingFact>[];
  complete: boolean;
}

/**
 * The parameter under judgement, and the consts of its function that parse it as a URL or resolve
 * it as a path.
 */
interface Subject {
  fn: FunctionWithBody;
  parameter: ParameterDeclaration;
  /** The parameter's name; only parameters named by an identifier are judged. */
  name: Identifier;
  symbol: SymbolAdapter | undefined;
  urls: Identifier[];
  paths: Identifier[];
}

/** The operation a database or queue call performs, as the service-loop rule summarises it. */
interface QueryOperation extends EffectSite {
  family: string;
  label: string;
}

// Hops followed from a function: controller -> service -> repository -> client is three, so four
// leaves one to spare.
const MAX_CALL_DEPTH = 4;
// Validators are short; a longer function is rarely a pure check and costs more to judge.
const MAX_VALIDATOR_STATEMENTS = 20;
const validationKinds: readonly ValidationKind[] = ['url', 'path', 'id'];
const queueFamilies = new Set(['redis', 'queue']);
// Request fields that carry client input; req.user, req.session and ctx.state are server data.
const requestFields = new Set([
  'body',
  'query',
  'params',
  'param',
  'headers',
  'header',
  'cookies',
  'signedCookies',
  'url',
  'originalUrl',
  'path',
  'hostname',
  'get',
  'input',
  'request',
  'req',
]);
const requestParameterNames = new Set(['req', 'request', 'ctx']);
// Library checks that leave only an ObjectId or a UUID, by module and export or method name.
const idChecks = new Map([
  ['mongoose', new Set(['isValidObjectId', 'isObjectIdOrHexString', 'isValid'])],
  ['mongodb', new Set(['isValid'])],
  ['bson', new Set(['isValid'])],
  ['validator', new Set(['isUUID', 'isMongoId'])],
  ['class-validator', new Set(['isUUID', 'isMongoId'])],
  ['uuid', new Set(['validate'])],
]);
const urlValueReaders = new Set(['href', 'toString']);

const summariesByProgram = new WeakMap<ProgramAdapter, FunctionSummaries>();

function functionSummaries(program: ProgramAdapter): FunctionSummaries {
  let summaries = summariesByProgram.get(program);
  if (!summaries) summariesByProgram.set(program, (summaries = createSummaries(program)));
  return summaries;
}

function createSummaries(program: ProgramAdapter): FunctionSummaries {
  const checker = program.getTypeChecker();
  // The native adapter is the checker that answers isDefaultLibrary itself (see compiler.cjs).
  const securityHelpersSupported = !checker.isDefaultLibrary;
  const summaries = new WeakMap<FunctionWithBody, FunctionSummary>();
  const localFacts = new WeakMap<FunctionWithBody, OwnFacts>();
  const validations = new WeakMap<FunctionWithBody, Validation[]>();
  const requestReturns = new WeakMap<FunctionWithBody, RequestData | undefined>();
  const context: SummaryContext = {
    program,
    checker,
    isPackageType: (node: Node, packages: readonly string[], typeNames?: readonly string[]) =>
      typeFromPackage(checker.getTypeAtLocation(node), packages, typeNames),
    libraryCall: (call: CallExpression) => libraryCall(call, context),
    // isContainedPath asks whether the resolve() root is client data; here a caller's argument is
    // unknown.
    taint: {
      trace: (expression: Expression) =>
        mentionsParameter(expression)
          ? {
              label: 'parameter',
              sourceNode: expression,
              sourceKind: 'parameter',
              hops: 0,
              whole: false,
              shape: 'unknown' as const,
              steps: [],
            }
          : undefined,
      isUntracedParameter: () => false,
      urlControl: () => undefined,
    },
    // Neither is read by the recognisers used here.
    strictNullChecks: false,
    report: () => {},
  };

  function securityContext(fn: FunctionWithBody): SecurityRuleContext {
    return { ...context, sourceFile: fn.getSourceFile(), fileContext: noFileContext };
  }

  function mentionsParameter(node: Node | undefined, depth = 0): boolean {
    const value = strip(node);
    if (!value || depth > 1) return false;
    if (ts.isIdentifier(value)) {
      const declaration = checker.getSymbolAtLocation(value)?.valueDeclaration;
      if (!declaration) return false;
      if (ts.isParameter(declaration)) return true;
      return isConst(declaration) && mentionsParameter(declaration.initializer, depth + 1);
    }
    return !!ts.forEachChild(value, (child: Node) => mentionsParameter(child, depth));
  }

  function calleeOf(call: CallExpression): FunctionWithBody | undefined {
    const declaration = signatureDeclaration(call, checker);
    return isProjectFunction(declaration) ? declaration : undefined;
  }

  function summaryOf(declaration: Node | undefined): FunctionSummary | undefined {
    if (!isProjectFunction(declaration)) return;
    let summary = summaries.get(declaration);
    if (!summary) summaries.set(declaration, (summary = createSummary(declaration)));
    return summary;
  }

  function createSummary(declaration: FunctionWithBody): FunctionSummary {
    let effects: ReachedEffects | undefined;
    let validates: Validation[] | undefined;
    let returnsRequestData: RequestData | null | undefined;
    const reachedEffects = () => (effects ??= reachableEffects(declaration));
    return {
      declaration,
      get queries() {
        return reachedEffects().queries;
      },
      get blocking() {
        return reachedEffects().blocking;
      },
      get complete() {
        return reachedEffects().complete;
      },
      get validates() {
        return (validates ??= securityHelpersSupported ? validationsOf(declaration) : []);
      },
      get returnsRequestData(): RequestData | undefined {
        if (returnsRequestData === undefined)
          returnsRequestData = (securityHelpersSupported && requestReturnOf(declaration)) || null;
        return returnsRequestData ?? undefined;
      },
    };
  }

  // Effects
  // ----------------------------------------------------------------------------------------------------

  // The function's own effects and the project functions it calls, with service-query-in-loop's
  // rules for which code runs: callbacks passed to calls do, nested functions only stored or
  // returned and catch blocks do not.
  function ownFacts(declaration: FunctionWithBody): OwnFacts {
    const known = localFacts.get(declaration);
    if (known) return known;
    const { operations, callees } = summarize(declaration, checker);
    const facts: OwnFacts = {
      queries: operations.map((operation: QueryOperation) => ({
        kind: queueFamilies.has(operation.family) ? operation.family : 'db',
        ...operation,
      })),
      blocking: [],
      callees: [...new Set(callees)],
    };
    (function visit(node: Node): void {
      if (ts.isFunctionLike(node) && node !== declaration && !runsWithBody(node)) return;
      if (ts.isClassLike(node) || ts.isCatchClause(node)) return;
      if (ts.isCallExpression(node)) {
        const http = httpCall(node);
        if (http) facts.queries.push({ kind: 'http', ...http, ...location(node) });
        const blocking = blockingCall(node);
        if (blocking) facts.blocking.push({ ...blocking, ...location(node) });
      }
      ts.forEachChild(node, visit);
    })(declaration.body);
    localFacts.set(declaration, facts);
    return facts;
  }

  function httpCall(call: CallExpression): { family: string; label: string } | undefined {
    const target = describeCall(call);
    if (!target) return;
    const known =
      target.library === 'fetch' ? isGlobalFetch(target.receiver, context) : isDefaultAxios(target.receiver, context);
    if (known) return { family: target.library, label: ts.skipOuterExpressions(call.expression).getText() };
  }

  function blockingCall(call: CallExpression): { kind: string; label: string } | undefined {
    const binding = blockingBinding(call, checker);
    if (binding) return { kind: binding.moduleName, label: `${binding.moduleName}.${binding.method}` };
    const name = calleeName(call);
    if (name !== undefined && asyncReplacements.has(name) && isBcryptCall(call, checker))
      return { kind: 'password-hash', label: name };
  }

  function doesWork(declaration: FunctionWithBody): boolean {
    const facts = ownFacts(declaration);
    return facts.queries.length > 0 || facts.blocking.length > 0 || facts.callees.length > 0;
  }

  function reachableEffects(root: FunctionWithBody): ReachedEffects {
    const queries: Reached<QueryFact>[] = [];
    const blocking: Reached<BlockingFact>[] = [];
    const visited = new Set<FunctionWithBody>([root]);
    let complete = true;
    // Records one function's own effects and returns the callees to follow from it next.
    const expandEntry = ({ declaration, via }: FrontierEntry, depth: number): FrontierEntry[] => {
      const facts = ownFacts(declaration);
      queries.push(...facts.queries.map((effect: QueryFact) => ({ ...effect, via })));
      blocking.push(...facts.blocking.map((effect: BlockingFact) => ({ ...effect, via })));
      const next: FrontierEntry[] = [];
      for (const callee of facts.callees) {
        if (visited.has(callee)) continue;
        if (depth === MAX_CALL_DEPTH) {
          if (doesWork(callee)) complete = false;
          continue;
        }
        visited.add(callee);
        next.push({ declaration: callee, via: [...via, functionLabel(callee)] });
      }
      return next;
    };
    let frontier: FrontierEntry[] = [{ declaration: root, via: [] }];
    for (let depth = 0; frontier.length > 0; depth++) {
      frontier = frontier.flatMap((entry) => expandEntry(entry, depth));
    }
    return { queries: distinctEffects(queries), blocking: distinctEffects(blocking), complete };
  }

  // Validation
  // -------------------------------------------------------------------------------------------------

  function validationsOf(fn: FunctionWithBody): Validation[] {
    const known = validations.get(fn);
    if (known) return known;
    // A recursive call reads this while the function is being judged: no validation yet.
    validations.set(fn, []);
    const found: Validation[] = [];
    const statements = ts.isBlock(fn.body) ? fn.body.statements.length : 1;
    if (statements <= MAX_VALIDATOR_STATEMENTS) {
      fn.parameters.forEach((parameter: ParameterDeclaration, parameterIndex: number) => {
        if (!ts.isIdentifier(parameter.name)) return;
        const subject = createSubject(fn, parameter, parameter.name);
        for (const kind of validationKinds) {
          const mode = validationMode(fn, subject, kind);
          if (mode) found.push({ parameterIndex, kind, mode });
        }
      });
    }
    validations.set(fn, found);
    return found;
  }

  // The parameter, and the consts in `fn` that parse it as a URL or resolve it as a path.
  function createSubject(fn: FunctionWithBody, parameter: ParameterDeclaration, name: Identifier): Subject {
    const symbol = checker.getSymbolAtLocation(parameter.name);
    const subject: Subject = { fn, parameter, name, symbol, urls: [], paths: [] };
    forEachOwnNode(fn, (node: Node) => {
      if (!isConst(node)) return;
      const value = strip(node.initializer);
      if (value && ts.isNewExpression(value) && isUrlConstructor(strip(value.expression), checker)) {
        if (value.arguments?.[0] && refersTo(value.arguments[0], symbol)) subject.urls.push(node.name);
      } else if (
        isPathResolve(value) &&
        value.arguments.slice(1).some((argument: Expression) => refersTo(argument, symbol))
      ) {
        subject.paths.push(node.name);
      }
    });
    return subject;
  }

  function isPathResolve(node: Node | undefined): node is CallExpression {
    if (!node || !ts.isCallExpression(node)) return false;
    const library = context.libraryCall(node);
    return library?.module === 'path' && (library.method ?? library.exported) === 'resolve';
  }

  function refersTo(node: Node | undefined, symbol: SymbolAdapter | undefined): boolean {
    const value = strip(node);
    if (!value) return false;
    if (ts.isIdentifier(value)) return checker.getSymbolAtLocation(value) === symbol;
    return !!ts.forEachChild(value, (child: Node) => refersTo(child, symbol));
  }

  function isParameterValue(node: Node | undefined, subject: Subject): boolean {
    const value = strip(node);
    return !!value && ts.isIdentifier(value) && checker.getSymbolAtLocation(value) === subject.symbol;
  }

  function validationMode(fn: FunctionWithBody, subject: Subject, kind: ValidationKind): ValidationMode | undefined {
    if (kind === 'path' && subject.paths.length === 0) return;
    const { body } = fn;
    const returned: (Expression | undefined)[] = ts.isBlock(body)
      ? returnStatements(fn).map((statement) => statement.expression)
      : [body];
    if (returnsValidated(returned, subject, kind)) return 'returns';
    if (throwsUnlessValid(fn, subject, kind)) return 'throws';
    if (returnsTrueOnlyWhenValid(returned, subject, kind)) return 'boolean';
  }

  // Every returned value is a literal or the validated argument, and at least one is the argument.
  function returnsValidated(
    returned: readonly (Expression | undefined)[],
    subject: Subject,
    kind: ValidationKind,
  ): boolean {
    const leaves = returned.flatMap((expression: Expression | undefined) =>
      expression ? valueLeaves(expression) : [],
    );
    let validated = 0;
    for (const leaf of leaves) {
      if (isLiteralValue(leaf)) continue;
      if (sanitizerCall(leaf, subject, kind)) {
        validated++;
        continue;
      }
      const value = subjectValue(leaf, subject, kind);
      if (!value || !isValidAt(leaf, value, subject, kind)) return false;
      validated++;
    }
    return validated > 0;
  }

  // A leaf that is the argument or the URL or path made from it, as recognisers see it, or
  // undefined.
  function subjectValue(leaf: Expression, subject: Subject, kind: ValidationKind): Expression | undefined {
    if (ts.isIdentifier(leaf)) {
      const symbol = checker.getSymbolAtLocation(leaf);
      if (symbol === subject.symbol) return subject.name;
      const derived = kind === 'url' ? subject.urls : kind === 'path' ? subject.paths : [];
      const matched = derived.find((name: Identifier) => checker.getSymbolAtLocation(name) === symbol);
      if (matched) return matched;
      const declaration = symbol?.valueDeclaration;
      // `const safe = sanitize(input); return safe;`
      return declaration && isConst(declaration) && sanitizerCall(declaration.initializer, subject, kind)
        ? leaf
        : undefined;
    }
    if (kind !== 'url') return;
    const reader = ts.isCallExpression(leaf) ? strip(leaf.expression) : leaf;
    if (!ts.isPropertyAccessExpression(reader) || !urlValueReaders.has(reader.name.text)) return;
    const owner = strip(reader.expression);
    return ts.isIdentifier(owner) ? subject.urls.find((name: Identifier) => sameSymbol(name, owner)) : undefined;
  }

  function sameSymbol(left: Node, right: Node): boolean {
    return checker.getSymbolAtLocation(left) === checker.getSymbolAtLocation(right);
  }

  // Every normal exit, including falling off the end, is reached only with a valid argument.
  function throwsUnlessValid(fn: FunctionWithBody, subject: Subject, kind: ValidationKind): boolean {
    const { body } = fn;
    if (!ts.isBlock(body)) return validatorCall(body, subject, kind, ['throws']);
    const exits: Statement[] = returnStatements(fn);
    if (fallsThrough(body)) exits.push(endOfBodySink(fn, body));
    return (
      exits.length > 0 &&
      exits.every(
        (exit: Statement) =>
          (ts.isReturnStatement(exit) &&
            exit.expression &&
            validatorCall(exit.expression, subject, kind, ['throws'])) ||
          isGuardedExit(exit, subject, kind),
      )
    );
  }

  // Every return is `false`, or a true value reached only with a valid argument.
  function returnsTrueOnlyWhenValid(
    returned: readonly (Expression | undefined)[],
    subject: Subject,
    kind: ValidationKind,
  ): boolean {
    let confirming = 0;
    for (const expression of returned) {
      const value = expression && strip(expression);
      if (!value || isBooleanLiteral(value, false)) continue;
      confirming++;
      if (isBooleanLiteral(value, true)) {
        if (!isGuardedExit(value, subject, kind)) return false;
      } else if (
        !validatorCall(value, subject, kind, ['boolean']) &&
        !isGuardedExit(whenTrueSink(value), subject, kind)
      )
        return false;
    }
    return confirming > 0;
  }

  function isGuardedExit(sink: Node, subject: Subject, kind: ValidationKind): boolean {
    const values = kind === 'url' ? [subject.name, ...subject.urls] : kind === 'path' ? subject.paths : [subject.name];
    return (
      values.some((value: Expression) => isValidAt(sink, value, subject, kind)) || projectGuarded(sink, subject, kind)
    );
  }

  // The recogniser of the kind's sink accepts `value` at `sink`, or a project validator was called
  // on the argument.
  function isValidAt(sink: Node, value: Expression, subject: Subject, kind: ValidationKind): boolean {
    if (projectGuarded(sink, subject, kind)) return true;
    if (kind === 'path') return isContainedPath(sink, value, securityContext(subject.fn));
    if (kind === 'url')
      return value === subject.name
        ? isRelativeRedirect(sink, value, securityContext(subject.fn))
        : isAllowedHost(sink, value, securityContext(subject.fn), false);
    if (value !== subject.name || !ts.isIdentifier(value)) return false;
    return (
      isGuardedUse(value, sink, checker) ||
      isGuardedByCondition(sink, (condition: Expression, truth: boolean) => truth && isIdCheck(condition, subject))
    );
  }

  function projectGuarded(sink: Node, subject: Subject, kind: ValidationKind): boolean {
    return (
      isGuardedByCondition(
        sink,
        (condition: Expression, truth: boolean) =>
          truth && validatorCall(condition, subject, kind, ['boolean', 'throws']),
      ) || precededByAssertion(sink, subject, kind)
    );
  }

  // `assertSafe(input);` as an earlier statement of an enclosing block.
  function precededByAssertion(sink: Node, subject: Subject, kind: ValidationKind): boolean {
    for (
      let child = sink, parent = sink.parent;
      parent && !ts.isFunctionLike(child);
      child = parent, parent = parent.parent
    ) {
      if (!ts.isBlock(parent)) continue;
      const earlier = parent.statements.slice(
        0,
        parent.statements.findIndex((statement) => statement === child),
      );
      if (
        earlier.some(
          (statement: Statement) =>
            ts.isExpressionStatement(statement) && validatorCall(statement.expression, subject, kind, ['throws']),
        )
      )
        return true;
    }
    return false;
  }

  function sanitizerCall(node: Node | undefined, subject: Subject, kind: ValidationKind): boolean {
    return validatorCall(node, subject, kind, ['returns']);
  }

  // A call of a project function that validates the argument for `kind` in one of `modes`.
  function validatorCall(
    node: Node | undefined,
    subject: Subject,
    kind: ValidationKind,
    modes: readonly ValidationMode[],
  ): boolean {
    const call = strip(node);
    if (!call || !ts.isCallExpression(call)) return false;
    const callee = calleeOf(call);
    if (!callee) return false;
    return validationsOf(callee).some(
      (validation: Validation) =>
        validation.kind === kind &&
        modes.includes(validation.mode) &&
        isParameterValue(call.arguments[validation.parameterIndex], subject),
    );
  }

  function isIdCheck(condition: Expression, subject: Subject): boolean {
    const call = strip(condition);
    if (!ts.isCallExpression(call) || call.arguments.length !== 1 || !isParameterValue(call.arguments[0], subject))
      return false;
    const library = context.libraryCall(call);
    if (!library?.module) return false;
    const [root, ...rest] = library.module.split('/');
    // `import isUUID from 'validator/lib/isUUID'`
    const name = library.method ?? (library.exported === 'default' ? rest.at(-1) : library.exported);
    return name !== undefined && !!idChecks.get(root)?.has(name);
  }

  // Request data
  // ------------------------------------------------------------------------------------------------

  function requestReturnOf(fn: FunctionWithBody): RequestData | undefined {
    if (requestReturns.has(fn)) return requestReturns.get(fn);
    requestReturns.set(fn, undefined);
    const { body } = fn;
    const returned: (Expression | undefined)[] = ts.isBlock(body)
      ? returnStatements(fn).map((statement) => statement.expression)
      : [body];
    let found: RequestData | undefined;
    for (const leaf of returned.flatMap((expression: Expression | undefined) =>
      expression ? valueLeaves(expression) : [],
    )) {
      found = requestValue(leaf, fn, 0);
      if (found) break;
    }
    requestReturns.set(fn, found);
    return found;
  }

  // { parameterIndex, path } when `node` reads client input from a request parameter of `fn`.
  function requestValue(node: Node | undefined, fn: FunctionWithBody, aliasDepth: number): RequestData | undefined {
    const value = strip(node);
    if (!value) return;
    if (ts.isCallExpression(value)) {
      const forwarded = forwardedRequestValue(value, fn);
      if (forwarded) return forwarded;
    }
    const fields: string[] = [];
    let current: Node | undefined = value;
    for (;;) {
      if (ts.isCallExpression(current)) current = strip(current.expression);
      else if (ts.isPropertyAccessExpression(current)) {
        fields.unshift(current.name.text);
        current = strip(current.expression);
      } else if (ts.isElementAccessExpression(current)) current = strip(current.expression);
      else break;
    }
    if (!ts.isIdentifier(current)) return;
    const declaration = checker.getSymbolAtLocation(current)?.valueDeclaration;
    if (declaration && isConst(declaration) && aliasDepth === 0 && fields.length === 0)
      return requestValue(declaration.initializer, fn, aliasDepth + 1);
    if (!declaration || !ts.isParameter(declaration) || declaration.parent !== fn) return;
    const parameterIndex = fn.parameters.indexOf(declaration);
    const source = parameterSource(declaration, checker);
    if (source === null) return;
    if (source?.taint) return { parameterIndex, path: fields.join('.') };
    const named = ts.isIdentifier(declaration.name) && requestParameterNames.has(declaration.name.text);
    if ((source || named) && requestFields.has(fields[0])) return { parameterIndex, path: fields.join('.') };
  }

  // `return readNext(req)` where readNext returns request data from the parameter given `req`.
  function forwardedRequestValue(call: CallExpression, fn: FunctionWithBody): RequestData | undefined {
    const callee = calleeOf(call);
    const inner = callee && requestReturnOf(callee);
    const argument = inner && strip(call.arguments[inner.parameterIndex]);
    if (!argument || !ts.isIdentifier(argument)) return;
    const declaration = checker.getSymbolAtLocation(argument)?.valueDeclaration;
    if (declaration && ts.isParameter(declaration) && declaration.parent === fn)
      return { parameterIndex: fn.parameters.indexOf(declaration), path: inner.path };
  }

  return { summaryOf, summaryOfCall: (call: CallExpression) => summaryOf(calleeOf(call)), calleeOf };
}

// One entry per call site, even when two call paths reach it.
function distinctEffects<Effect extends EffectSite & { label: string }>(effects: readonly Effect[]): Effect[] {
  const seen = new Set<string>();
  return effects.filter((effect: Effect) => {
    const key = `${effect.file}:${effect.line}:${effect.column}:${effect.label}`;
    return !seen.has(key) && seen.add(key);
  });
}

export { functionSummaries };
