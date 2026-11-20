'use strict';

// Demand-driven backward taint: a rule finds a sink, then asks whether the sink argument traces to request data.
// The interface is frozen (security design section 2.1); rule groups depend on exactly these three functions.
const path = require('node:path');
const { syntax: ts } = require('../../performance/compiler.cjs');
const { parameterSource } = require('./sources.cjs');
const { propagation } = require('./propagate.cjs');
const { isNumericCall, isPrunedType, isGuarded, stringIsSafe } = require('./sanitizers.cjs');
const { createSummaries } = require('./summaries.cjs');
const { urlPart } = require('./url-parts.cjs');

const sinkKinds = new Set([
  'sql',
  'nosql',
  'shell',
  'code',
  'regex',
  'url',
  'redirect',
  'path',
  'html',
  'proto-key',
  'mass-assignment',
  'template',
]);
// Caller-direction hops tracked; a third is not followed.
const maxHops = 2;
const maxLabelLength = 60;
const maxStepTextLength = 80;

const summariesByProgram = new WeakMap();

function strip(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isAwaitExpression(current))
  )
    current = current.expression;
  return current;
}

function oneLine(text, limit) {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? line.slice(0, limit - 3) + '...' : line;
}

function step(node) {
  const sourceFile = node.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const file = path.relative(process.cwd(), sourceFile.fileName).split(path.sep).join('/');
  return { file, line: line + 1, text: oneLine(node.getText(sourceFile), maxStepTextLength) };
}

function propertyName(access) {
  if (ts.isPropertyAccessExpression(access)) return access.name.text;
  const argument = strip(access.argumentExpression);
  return argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

function declarationOf(identifier, checker) {
  const symbol = ts.isShorthandPropertyAssignment(identifier.parent)
    ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
    : checker.getSymbolAtLocation(identifier);
  if (!symbol || symbol.flags & ts.SymbolFlags.Alias) return;
  return symbol.valueDeclaration ?? symbol.declarations?.[0];
}

// Internal results: { taint } for a tainted value, { container } for a request object whose listed fields are
// tainted, or { parameter: index } for the symbolic parameter of a return summary. Each carries steps and hops.
function createTaint(program) {
  const checker = program.getTypeChecker();
  if (!summariesByProgram.has(program)) summariesByProgram.set(program, createSummaries(program));
  const summaries = summariesByProgram.get(program);
  const results = new Map();

  function source(taint, label, node, hops) {
    return { taint, label: oneLine(label, maxLabelLength), sourceNode: node, hops, steps: [step(node)] };
  }

  function withStep(result, node) {
    return result && { ...result, steps: [...result.steps, step(node)] };
  }

  function partOf(result, keepWhole) {
    if (!result || result.container) return result?.container ? undefined : result;
    return keepWhole || result.parameter !== undefined ? result : { ...result, taint: 'scalar' };
  }

  function first(nodes, resolveNode, keepWhole) {
    for (const node of nodes) {
      const result = partOf(resolveNode(node), keepWhole);
      if (result) return result;
    }
  }

  function resolve(node, state) {
    const expression = strip(node);
    if (!expression) return;
    const key = `${state.sinkKind}:${state.hops}:${state.summary?.index ?? ''}`;
    let byKey = results.get(expression);
    if (!byKey) results.set(expression, (byKey = new Map()));
    if (byKey.has(key)) return byKey.get(key);
    // A cycle (`let a = b; b = a`) resolves to clean.
    byKey.set(key, undefined);
    const result = isPrunedType(expression, checker) ? undefined : resolveExpression(expression, state);
    byKey.set(key, result);
    return result;
  }

  function resolveExpression(expression, state) {
    const next = (node) => resolve(node, state);
    if (ts.isTemplateExpression(expression)) {
      if (stringIsSafe(state.sinkKind)) return;
      return first(
        expression.templateSpans.map((span) => span.expression),
        next,
      );
    }
    if (ts.isBinaryExpression(expression)) return resolveBinary(expression, next);
    if (ts.isConditionalExpression(expression)) return first([expression.whenTrue, expression.whenFalse], next, true);
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
      return resolveAccess(expression, next);
    if (ts.isIdentifier(expression)) return resolveIdentifier(expression, state);
    if (ts.isCallExpression(expression)) return resolveCall(expression, state);
    if (ts.isNewExpression(expression)) {
      const constructor = expression.expression;
      if (ts.isIdentifier(constructor) && (constructor.text === 'URL' || constructor.text === 'URLSearchParams'))
        return partOf(next(expression.arguments?.[0]));
      return;
    }
    if (ts.isObjectLiteralExpression(expression)) return resolveObject(expression, next);
    if (ts.isArrayLiteralExpression(expression)) return first(expression.elements, next);
    if (ts.isSpreadElement(expression)) return next(expression.expression);
  }

  function resolveBinary(expression, next) {
    const operator = expression.operatorToken.kind;
    if (operator === ts.SyntaxKind.PlusToken) return first([expression.left, expression.right], next);
    if (operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken)
      return first([expression.left, expression.right], next, true);
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.CommaToken ||
      operator === ts.SyntaxKind.EqualsToken
    )
      return next(expression.right);
  }

  function resolveAccess(expression, next) {
    const name = propertyName(expression);
    if (name === 'length') return;
    const receiver = next(expression.expression);
    if (!receiver) return;
    if (receiver.container) {
      const field =
        name === undefined || /^\d+$/.test(name) ? receiver.container.element : receiver.container.fields?.[name];
      if (!field) return;
      const label = expression.getText();
      if (field.taint)
        return {
          ...source(field.taint, label, expression, receiver.hops),
          steps: [...receiver.steps, step(expression)],
        };
      return { container: field, label, hops: receiver.hops, steps: receiver.steps };
    }
    // `req.body` read as `req.body.name`, `@Body() dto` read as `@Body() dto.name`.
    const receiverText = strip(expression.expression).getText();
    const label = receiver.label?.endsWith(receiverText)
      ? oneLine(receiver.label.slice(0, -receiverText.length) + expression.getText(), maxLabelLength)
      : receiver.label;
    return { ...partOf(receiver), label };
  }

  function resolveObject(expression, next) {
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = partOf(next(property.expression), true);
        if (spread) return spread;
        continue;
      }
      const value = ts.isPropertyAssignment(property)
        ? property.initializer
        : ts.isShorthandPropertyAssignment(property)
          ? property.name
          : undefined;
      const result = value && partOf(next(value));
      if (result) return result;
    }
  }

  function resolveIdentifier(identifier, state) {
    const declaration = declarationOf(identifier, checker);
    if (!declaration) return;
    if (
      !state.summary &&
      (ts.isParameter(declaration) || ts.isVariableDeclaration(declaration)) &&
      isGuarded(identifier, identifier, checker)
    )
      return;
    if (ts.isParameter(declaration)) return resolveParameter(declaration, state);
    if (ts.isBindingElement(declaration)) return resolveBinding(declaration, state);
    if (ts.isVariableDeclaration(declaration)) return resolveVariable(declaration, identifier, state);
  }

  function resolveParameter(parameter, state) {
    const fn = parameter.parent;
    const index = fn.parameters.indexOf(parameter);
    if (state.summary)
      return state.summary.fn === fn && state.summary.index === index
        ? { parameter: index, steps: [], hops: 0 }
        : undefined;
    const found = parameterSource(parameter, checker);
    if (found === null) return;
    if (found?.container)
      return { container: found.container, label: found.label, hops: state.hops, steps: [step(parameter)] };
    if (found) return source(found.taint, found.label, parameter, state.hops);
    if (state.hops >= maxHops || !ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) return;
    for (const call of summaries.callSites(fn)) {
      const argument = call.arguments[index];
      const result = argument && resolve(argument, { ...state, hops: state.hops + 1 });
      if (result?.taint) return { ...result, steps: [...result.steps, step(call), step(parameter)] };
    }
  }

  // `const { body: { name } } = req`: the property path below the bound value, outermost first.
  function resolveBinding(element, state) {
    const names = [];
    let current = element;
    while (ts.isBindingElement(current)) {
      const pattern = current.parent;
      if (current.dotDotDotToken) names.unshift(null);
      else if (ts.isArrayBindingPattern(pattern)) names.unshift(undefined);
      else {
        const property = current.propertyName ?? current.name;
        names.unshift(ts.isIdentifier(property) || ts.isStringLiteralLike(property) ? property.text : undefined);
      }
      current = pattern.parent;
    }
    let result;
    if (ts.isParameter(current)) result = resolveParameter(current, state);
    else if (ts.isVariableDeclaration(current) && current.initializer) result = resolve(current.initializer, state);
    else if (ts.isVariableDeclaration(current)) result = resolveLoopVariable(current, state);
    for (const name of names) {
      if (!result) return;
      // A rest element keeps every remaining field.
      if (name === null) continue;
      if (result.container) {
        const field = name === undefined ? result.container.element : result.container.fields?.[name];
        if (!field) return;
        result = field.taint
          ? {
              ...source(field.taint, element.name.getText(), element, result.hops),
              steps: [...result.steps, step(element)],
            }
          : { ...result, container: field };
      } else result = partOf(result);
    }
    return withStep(result, element);
  }

  // `for (const item of items)`: an element of the iterated value.
  function resolveLoopVariable(declaration, state) {
    const loop = declaration.parent.parent;
    if (!ts.isForOfStatement(loop) && !ts.isForInStatement(loop)) return;
    const iterated = resolve(loop.expression, state);
    if (iterated?.container) {
      const element = iterated.container.element;
      return element && { container: element, label: iterated.label, hops: iterated.hops, steps: iterated.steps };
    }
    return partOf(iterated);
  }

  function resolveVariable(declaration, identifier, state) {
    if (!declaration.initializer) return withStep(resolveLoopVariable(declaration, state), declaration);
    const initial = resolve(declaration.initializer, state);
    if (initial || declaration.parent.flags & ts.NodeFlags.Const) return withStep(initial, declaration);
    // `let` and `var`: any write in the same function can taint the variable.
    const scope = ts.findAncestor(declaration, (node) => ts.isFunctionLike(node) || ts.isSourceFile(node));
    let assigned;
    (function visit(node) {
      if (assigned) return;
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) &&
        ts.isIdentifier(node.left) &&
        node.left !== identifier &&
        declarationOf(node.left, checker) === declaration
      )
        assigned = withStep(partOf(resolve(node.right, state), true), node);
      ts.forEachChild(node, visit);
    })(scope);
    return assigned;
  }

  function resolveCall(call, state) {
    if (isNumericCall(call)) return;
    const callee = strip(call.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const receiver = resolve(callee.expression, state);
      const returned = receiver?.container?.calls?.[callee.name.text];
      if (returned)
        return {
          ...source(returned.taint, call.getText(), call, receiver.hops),
          steps: [...receiver.steps, step(call)],
        };
      // `new URL(input).searchParams.get('next')`
      if (
        ['get', 'getAll'].includes(callee.name.text) &&
        ts.isPropertyAccessExpression(strip(callee.expression)) &&
        strip(callee.expression).name.text === 'searchParams'
      )
        return partOf(receiver);
    }
    const propagated = propagation(call, checker);
    if (propagated) return resolvePropagation(call, callee, propagated, state);
    if (state.summary) return;
    const fn = summaries.localCallee(call);
    if (!fn) return;
    const indexes = summaries.returnSummary(fn, state.sinkKind, (expression, index) =>
      Boolean(resolve(expression, { sinkKind: state.sinkKind, hops: 0, summary: { fn, index } })),
    );
    for (const index of indexes) {
      const argument = call.arguments[index];
      const result = argument && partOf(resolve(argument, state), true);
      if (result) return withStep(result, call);
    }
  }

  function resolvePropagation(call, callee, { from, name }, state) {
    if (from === 'receiver') return partOf(resolve(callee.expression, state));
    if (name === 'String' && stringIsSafe(state.sinkKind)) return;
    const keepWhole = from === 'keep' || from === 'keep-any';
    const inputs = from === 'any' || from === 'keep-any' ? call.arguments : call.arguments.slice(0, 1);
    return first(inputs, (node) => resolve(node, state), keepWhole);
  }

  function publicTrace(result, expression) {
    const type = checker.getTypeAtLocation(expression);
    const flags = type.flags;
    const shape =
      flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
        ? 'unknown'
        : flags & ts.TypeFlags.StringLike
          ? 'string'
          : flags & ts.TypeFlags.Object
            ? 'object'
            : 'unknown';
    return {
      label: result.label,
      sourceNode: result.sourceNode,
      sourceKind: 'request',
      hops: result.hops,
      whole: result.taint === 'whole',
      shape,
      steps: result.steps,
    };
  }

  function trace(expression, sinkKind) {
    if (!sinkKinds.has(sinkKind)) throw new Error('Unknown sink kind: ' + sinkKind);
    const result = resolve(expression, { sinkKind, hops: 0 });
    return result?.taint ? publicTrace(result, strip(expression)) : undefined;
  }

  function isUntracedParameter(expression) {
    let node = strip(expression);
    const visited = new Set();
    while (node && ts.isIdentifier(node) && !visited.has(node)) {
      visited.add(node);
      const declaration = declarationOf(node, checker);
      if (!declaration) return false;
      if (ts.isParameter(declaration)) {
        return parameterSource(declaration, checker) === undefined && !resolve(node, { sinkKind: 'code', hops: 0 });
      }
      const constant = ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const;
      node = constant ? strip(declaration.initializer) : undefined;
    }
    return false;
  }

  function urlControl(expression) {
    const traced = trace(expression, 'url');
    if (!traced) return;
    return { part: urlPart(strip(expression), checker), trace: traced };
  }

  return { trace, isUntracedParameter, urlControl };
}

module.exports = { createTaint, sinkKinds };
