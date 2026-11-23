'use strict';

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
const { syntax: ts } = require('../performance/compiler.cjs');
const { calleeName } = require('../performance/call-syntax.cjs');
const { location } = require('../performance/schema/ts-helpers.cjs');
const { runsWithBody, signatureDeclaration, summarize } = require('../performance/service-loops.cjs');
const { blockingBinding } = require('../performance/node-fs.cjs');
const { asyncReplacements, isBcryptCall } = require('../performance/password-hashing.cjs');
const { describeCall, isDefaultAxios, isGlobalFetch } = require('../performance/http-timeouts.cjs');
const { typeFromPackage } = require('../performance/package-types.cjs');
const { libraryCall } = require('../security/bindings.cjs');
const { isContainedPath, isAllowedHost, isRelativeRedirect, strip } = require('../security/request-forgery/shared.cjs');
const { isGuardedByCondition, isGuardedUse } = require('../security/taint/guards.cjs');
const { parameterSource } = require('../security/taint/sources.cjs');
const { isProjectSource } = require('../security/taint/summaries.cjs');
const { isUrlConstructor } = require('../security/taint/url-parts.cjs');

// Hops followed from a function: controller -> service -> repository -> client is three, so four leaves one to spare.
const MAX_CALL_DEPTH = 4;
// Validators are short; a longer function is rarely a pure check and costs more to judge.
const MAX_VALIDATOR_STATEMENTS = 20;
const validationKinds = ['url', 'path', 'id'];
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

const summariesByProgram = new WeakMap();

function functionSummaries(program) {
  let summaries = summariesByProgram.get(program);
  if (!summaries) summariesByProgram.set(program, (summaries = createSummaries(program)));
  return summaries;
}

function isProjectFunction(declaration) {
  return (
    !!declaration &&
    ts.isFunctionLike(declaration) &&
    !!declaration.body &&
    isProjectSource(declaration.getSourceFile())
  );
}

function functionLabel(fn) {
  let name = fn.name && ts.isIdentifier(fn.name) ? fn.name.text : undefined;
  if (!name && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) name = fn.parent.name.text;
  const owner = ts.isClassLike(fn.parent) && fn.parent.name ? `${fn.parent.name.text}.` : '';
  return owner + (name ?? 'anonymous');
}

function isConst(declaration) {
  return (
    ts.isVariableDeclaration(declaration) &&
    !!(declaration.parent.flags & ts.NodeFlags.Const) &&
    ts.isIdentifier(declaration.name) &&
    !!declaration.initializer
  );
}

// Visits `fn`'s own body, skipping nested functions.
function forEachOwnNode(fn, visit) {
  (function walk(node) {
    if (node !== fn && ts.isFunctionLike(node)) return;
    visit(node);
    ts.forEachChild(node, walk);
  })(fn.body);
}

function returnStatements(fn) {
  const returns = [];
  forEachOwnNode(fn, (node) => {
    if (ts.isReturnStatement(node)) returns.push(node);
  });
  return returns;
}

function fallsThrough(fn) {
  const last = fn.body.statements.at(-1);
  return !last || !(ts.isReturnStatement(last) || ts.isThrowStatement(last));
}

// The values a returned expression can take: both branches of a conditional, without wrappers or await.
function valueLeaves(expression) {
  const value = strip(expression);
  if (value && ts.isConditionalExpression(value))
    return [...valueLeaves(value.whenTrue), ...valueLeaves(value.whenFalse)];
  return value ? [value] : [];
}

function isLiteralValue(node) {
  return (
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === 'undefined')
  );
}

const isBooleanLiteral = (node, value) =>
  node.kind === (value ? ts.SyntaxKind.TrueKeyword : ts.SyntaxKind.FalseKeyword);

// Sink recognisers judge a use by the guards between it and the function start. The end of a body and the true
// branch of a returned condition have no node of their own, so these stand-ins are placed there.
function endOfBodySink(fn) {
  const block = { kind: ts.SyntaxKind.Block, parent: fn };
  const sink = standIn(block, fn.body.end);
  block.statements = [...fn.body.statements, sink];
  return sink;
}

function whenTrueSink(condition) {
  const branch = { kind: ts.SyntaxKind.IfStatement, expression: condition, parent: condition };
  branch.thenStatement = standIn(branch, condition.end);
  return branch.thenStatement;
}

function standIn(parent, position) {
  return {
    kind: ts.SyntaxKind.EmptyStatement,
    parent,
    pos: position,
    end: position,
    getStart: () => position,
    getSourceFile: () => parent.parent.getSourceFile(),
  };
}

function createSummaries(program) {
  const checker = program.getTypeChecker();
  // The native adapter is the checker that answers isDefaultLibrary itself (see compiler.cjs).
  const securityHelpersSupported = !checker.isDefaultLibrary;
  const summaries = new WeakMap();
  const localFacts = new WeakMap();
  const validations = new WeakMap();
  const requestReturns = new WeakMap();
  const context = {
    program,
    checker,
    isPackageType: (node, packages, typeNames) => typeFromPackage(checker.getTypeAtLocation(node), packages, typeNames),
    libraryCall: (call) => libraryCall(call, context),
    // isContainedPath asks whether the resolve() root is client data; here a caller's argument is unknown.
    taint: { trace: (node) => (mentionsParameter(node) ? { steps: [] } : undefined) },
  };

  function mentionsParameter(node, depth = 0) {
    const value = strip(node);
    if (!value || depth > 1) return false;
    if (ts.isIdentifier(value)) {
      const declaration = checker.getSymbolAtLocation(value)?.valueDeclaration;
      if (!declaration) return false;
      if (ts.isParameter(declaration)) return true;
      return isConst(declaration) && mentionsParameter(declaration.initializer, depth + 1);
    }
    return !!ts.forEachChild(value, (child) => mentionsParameter(child, depth));
  }

  function calleeOf(call) {
    const declaration = signatureDeclaration(call, checker);
    return isProjectFunction(declaration) ? declaration : undefined;
  }

  function summaryOf(declaration) {
    if (!isProjectFunction(declaration)) return;
    let summary = summaries.get(declaration);
    if (!summary) summaries.set(declaration, (summary = createSummary(declaration)));
    return summary;
  }

  function createSummary(declaration) {
    let effects;
    let validates;
    let returnsRequestData;
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
      get returnsRequestData() {
        if (returnsRequestData === undefined)
          returnsRequestData = (securityHelpersSupported && requestReturnOf(declaration)) || null;
        return returnsRequestData ?? undefined;
      },
    };
  }

  // Effects ----------------------------------------------------------------------------------------------------

  // The function's own effects and the project functions it calls, with service-query-in-loop's rules for which
  // code runs: callbacks passed to calls do, nested functions only stored or returned and catch blocks do not.
  function ownFacts(declaration) {
    let facts = localFacts.get(declaration);
    if (facts) return facts;
    const { operations, callees } = summarize(declaration, checker);
    facts = {
      queries: operations.map((operation) => ({
        kind: queueFamilies.has(operation.family) ? operation.family : 'db',
        ...operation,
      })),
      blocking: [],
      callees: [...new Set(callees)],
    };
    (function visit(node) {
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

  function httpCall(call) {
    const target = describeCall(call);
    if (!target) return;
    const known =
      target.library === 'fetch' ? isGlobalFetch(target.receiver, context) : isDefaultAxios(target.receiver, context);
    if (known) return { family: target.library, label: ts.skipOuterExpressions(call.expression).getText() };
  }

  function blockingCall(call) {
    const binding = blockingBinding(call, checker);
    if (binding) return { kind: binding.moduleName, label: `${binding.moduleName}.${binding.method}` };
    const name = calleeName(call);
    if (asyncReplacements.has(name) && isBcryptCall(call, checker)) return { kind: 'password-hash', label: name };
  }

  function doesWork(declaration) {
    const facts = ownFacts(declaration);
    return facts.queries.length > 0 || facts.blocking.length > 0 || facts.callees.length > 0;
  }

  function reachableEffects(root) {
    const queries = [];
    const blocking = [];
    const visited = new Set([root]);
    let complete = true;
    let frontier = [{ declaration: root, via: [] }];
    for (let depth = 0; frontier.length > 0; depth++) {
      const next = [];
      for (const { declaration, via } of frontier) {
        const facts = ownFacts(declaration);
        queries.push(...facts.queries.map((effect) => ({ ...effect, via })));
        blocking.push(...facts.blocking.map((effect) => ({ ...effect, via })));
        for (const callee of facts.callees) {
          if (visited.has(callee)) continue;
          if (depth === MAX_CALL_DEPTH) {
            if (doesWork(callee)) complete = false;
            continue;
          }
          visited.add(callee);
          next.push({ declaration: callee, via: [...via, functionLabel(callee)] });
        }
      }
      frontier = next;
    }
    return { queries: distinctEffects(queries), blocking: distinctEffects(blocking), complete };
  }

  // Validation -------------------------------------------------------------------------------------------------

  function validationsOf(fn) {
    if (validations.has(fn)) return validations.get(fn);
    // A recursive call reads this while the function is being judged: no validation yet.
    validations.set(fn, []);
    const found = [];
    const statements = ts.isBlock(fn.body) ? fn.body.statements.length : 1;
    if (statements <= MAX_VALIDATOR_STATEMENTS) {
      fn.parameters.forEach((parameter, parameterIndex) => {
        if (!ts.isIdentifier(parameter.name)) return;
        const subject = createSubject(fn, parameter);
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
  function createSubject(fn, parameter) {
    const symbol = checker.getSymbolAtLocation(parameter.name);
    const subject = { fn, parameter, symbol, urls: [], paths: [] };
    forEachOwnNode(fn, (node) => {
      if (!isConst(node)) return;
      const value = strip(node.initializer);
      if (ts.isNewExpression(value) && isUrlConstructor(strip(value.expression), checker)) {
        if (value.arguments?.[0] && refersTo(value.arguments[0], symbol)) subject.urls.push(node.name);
      } else if (isPathResolve(value) && value.arguments.slice(1).some((argument) => refersTo(argument, symbol))) {
        subject.paths.push(node.name);
      }
    });
    return subject;
  }

  function isPathResolve(node) {
    if (!node || !ts.isCallExpression(node)) return false;
    const library = context.libraryCall(node);
    return library?.module === 'path' && (library.method ?? library.exported) === 'resolve';
  }

  function refersTo(node, symbol) {
    const value = strip(node);
    if (!value) return false;
    if (ts.isIdentifier(value)) return checker.getSymbolAtLocation(value) === symbol;
    return !!ts.forEachChild(value, (child) => refersTo(child, symbol));
  }

  function isParameterValue(node, subject) {
    const value = strip(node);
    return !!value && ts.isIdentifier(value) && checker.getSymbolAtLocation(value) === subject.symbol;
  }

  function validationMode(fn, subject, kind) {
    if (kind === 'path' && subject.paths.length === 0) return;
    const returned = ts.isBlock(fn.body) ? returnStatements(fn).map((statement) => statement.expression) : [fn.body];
    if (returnsValidated(returned, subject, kind)) return 'returns';
    if (throwsUnlessValid(fn, subject, kind)) return 'throws';
    if (returnsTrueOnlyWhenValid(returned, subject, kind)) return 'boolean';
  }

  // Every returned value is a literal or the validated argument, and at least one is the argument.
  function returnsValidated(returned, subject, kind) {
    const leaves = returned.flatMap((expression) => (expression ? valueLeaves(expression) : []));
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

  // A leaf that is the argument or the URL or path made from it, as recognisers see it, or undefined.
  function subjectValue(leaf, subject, kind) {
    if (ts.isIdentifier(leaf)) {
      const symbol = checker.getSymbolAtLocation(leaf);
      if (symbol === subject.symbol) return subject.parameter.name;
      const derived = kind === 'url' ? subject.urls : kind === 'path' ? subject.paths : [];
      const matched = derived.find((name) => checker.getSymbolAtLocation(name) === symbol);
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
    return ts.isIdentifier(owner) ? subject.urls.find((name) => sameSymbol(name, owner)) : undefined;
  }

  function sameSymbol(left, right) {
    return checker.getSymbolAtLocation(left) === checker.getSymbolAtLocation(right);
  }

  // Every normal exit, including falling off the end, is reached only with a valid argument.
  function throwsUnlessValid(fn, subject, kind) {
    if (!ts.isBlock(fn.body)) return validatorCall(fn.body, subject, kind, ['throws']);
    const exits = returnStatements(fn);
    if (fallsThrough(fn)) exits.push(endOfBodySink(fn));
    return (
      exits.length > 0 &&
      exits.every(
        (exit) =>
          (exit.expression && validatorCall(exit.expression, subject, kind, ['throws'])) ||
          isGuardedExit(exit, subject, kind),
      )
    );
  }

  // Every return is `false`, or a true value reached only with a valid argument.
  function returnsTrueOnlyWhenValid(returned, subject, kind) {
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

  function isGuardedExit(sink, subject, kind) {
    const values =
      kind === 'url'
        ? [subject.parameter.name, ...subject.urls]
        : kind === 'path'
          ? subject.paths
          : [subject.parameter.name];
    return values.some((value) => isValidAt(sink, value, subject, kind)) || projectGuarded(sink, subject, kind);
  }

  // The recogniser of the kind's sink accepts `value` at `sink`, or a project validator was called on the argument.
  function isValidAt(sink, value, subject, kind) {
    if (projectGuarded(sink, subject, kind)) return true;
    if (kind === 'path') return isContainedPath(sink, value, context);
    if (kind === 'url')
      return value === subject.parameter.name
        ? isRelativeRedirect(sink, value, context)
        : isAllowedHost(sink, value, context, false);
    if (value !== subject.parameter.name) return false;
    return (
      isGuardedUse(value, sink, checker) ||
      isGuardedByCondition(sink, (condition, truth) => truth && isIdCheck(condition, subject))
    );
  }

  function projectGuarded(sink, subject, kind) {
    return (
      isGuardedByCondition(
        sink,
        (condition, truth) => truth && validatorCall(condition, subject, kind, ['boolean', 'throws']),
      ) || precededByAssertion(sink, subject, kind)
    );
  }

  // `assertSafe(input);` as an earlier statement of an enclosing block.
  function precededByAssertion(sink, subject, kind) {
    for (
      let child = sink, parent = sink.parent;
      parent && !ts.isFunctionLike(child);
      child = parent, parent = parent.parent
    ) {
      if (!ts.isBlock(parent)) continue;
      const earlier = parent.statements.slice(0, parent.statements.indexOf(child));
      if (
        earlier.some(
          (statement) =>
            ts.isExpressionStatement(statement) && validatorCall(statement.expression, subject, kind, ['throws']),
        )
      )
        return true;
    }
    return false;
  }

  function sanitizerCall(node, subject, kind) {
    return validatorCall(node, subject, kind, ['returns']);
  }

  // A call of a project function that validates the argument for `kind` in one of `modes`.
  function validatorCall(node, subject, kind, modes) {
    const call = strip(node);
    if (!call || !ts.isCallExpression(call)) return false;
    const callee = calleeOf(call);
    if (!callee) return false;
    return validationsOf(callee).some(
      (validation) =>
        validation.kind === kind &&
        modes.includes(validation.mode) &&
        isParameterValue(call.arguments[validation.parameterIndex], subject),
    );
  }

  function isIdCheck(condition, subject) {
    const call = strip(condition);
    if (!ts.isCallExpression(call) || call.arguments.length !== 1 || !isParameterValue(call.arguments[0], subject))
      return false;
    const library = context.libraryCall(call);
    if (!library?.module) return false;
    const [root, ...rest] = library.module.split('/');
    // `import isUUID from 'validator/lib/isUUID'`
    const name = library.method ?? (library.exported === 'default' ? rest.at(-1) : library.exported);
    return !!idChecks.get(root)?.has(name);
  }

  // Request data ------------------------------------------------------------------------------------------------

  function requestReturnOf(fn) {
    if (requestReturns.has(fn)) return requestReturns.get(fn);
    requestReturns.set(fn, undefined);
    const returned = ts.isBlock(fn.body) ? returnStatements(fn).map((statement) => statement.expression) : [fn.body];
    let found;
    for (const leaf of returned.flatMap((expression) => (expression ? valueLeaves(expression) : []))) {
      found = requestValue(leaf, fn, 0);
      if (found) break;
    }
    requestReturns.set(fn, found);
    return found;
  }

  // { parameterIndex, path } when `node` reads client input from a request parameter of `fn`.
  function requestValue(node, fn, aliasDepth) {
    const value = strip(node);
    if (!value) return;
    if (ts.isCallExpression(value)) {
      const forwarded = forwardedRequestValue(value, fn);
      if (forwarded) return forwarded;
    }
    const fields = [];
    let current = value;
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
  function forwardedRequestValue(call, fn) {
    const callee = calleeOf(call);
    const inner = callee && requestReturnOf(callee);
    const argument = inner && strip(call.arguments[inner.parameterIndex]);
    if (!argument || !ts.isIdentifier(argument)) return;
    const declaration = checker.getSymbolAtLocation(argument)?.valueDeclaration;
    if (declaration && ts.isParameter(declaration) && declaration.parent === fn)
      return { parameterIndex: fn.parameters.indexOf(declaration), path: inner.path };
  }

  return { summaryOf, summaryOfCall: (call) => summaryOf(calleeOf(call)), calleeOf };
}

// One entry per call site, even when two call paths reach it.
function distinctEffects(effects) {
  const seen = new Set();
  return effects.filter((effect) => {
    const key = `${effect.file}:${effect.line}:${effect.column}:${effect.label}`;
    return !seen.has(key) && seen.add(key);
  });
}

module.exports = { functionSummaries };
