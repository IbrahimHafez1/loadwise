// Demand-driven backward taint: a rule finds a sink, then asks whether the sink argument traces to
// request data. The interface is frozen (security design section 2.1); rule groups depend on
// exactly these three functions.
import { stripExpression as strip } from '../bindings.js';
import path from 'node:path';
import { ts } from '../../performance/compiler.js';
import { parameterSource, h3SourceCall } from './sources.js';
import { archiveParameter, archiveLoopEntry } from './archive-sources.js';
import { propagation } from './propagate.js';
import { isNumericCall, isPrunedType, isGuarded, stringIsSafe, isRegexEscape } from './sanitizers.js';
import { validatedField, schemaCall, schemaShape } from './validators.js';
import { createSummaries, argumentValidations } from './summaries.js';
import { assignmentsTo } from './guards.js';
import { createUrlControl, isUrlConstructor } from './url-parts.js';
import type {
  BinaryExpression,
  BindingElement,
  BindingPattern,
  CallExpression,
  ElementAccessExpression,
  Expression,
  Identifier,
  Node,
  ObjectLiteralExpression,
  ParameterDeclaration,
  PropertyAccessExpression,
  PropertyName,
  VariableDeclaration,
} from 'typescript';
import type {
  CheckerAdapter,
  ParameterSource,
  ProgramAdapter,
  SchemaShape,
  SinkKind,
  TaintApi,
  TaintResult,
  TaintState,
  TaintSummaries,
  Trace,
  TraceStep,
} from '../../shared/types.js';
import type { Propagation } from '../types/propagation.js';
import type { SchemaCall } from '../types/schema-call.js';

const sinkKinds = new Set<string>([
  'sql',
  'nosql',
  'shell',
  'code',
  'regex',
  'url',
  'redirect',
  'path',
  'archive-path',
  'html',
  'proto-key',
  'mass-assignment',
  'template',
]);
// Validation kinds (lib/shared/function-summaries.cjs) whose sanitizing helpers leave a clean value
// for a sink kind.
const sanitizedKinds = new Map<string, string[]>([
  ['redirect', ['url']],
  ['url', ['url']],
  ['path', ['path', 'id']],
]);
// Caller-direction hops tracked; a fourth is not followed.
const maxHops = 3;
const maxLabelLength = 60;
const maxStepTextLength = 80;

const summariesByProgram = new WeakMap<ProgramAdapter, TaintSummaries>();

/**
 * The property path of a destructured binding: a name, undefined for an array index, null for a
 * rest element.
 */
type BindingPathSegment = string | null | undefined;

type ResolveNext = (node: Expression | undefined) => TaintResult | undefined;

/**
 * A result that carries taint: it always has the label and node of the request data it came from.
 */
type TracedResult = TaintResult & { label: string; sourceNode: Node };

function summariesOf(program: ProgramAdapter): TaintSummaries {
  let summaries = summariesByProgram.get(program);
  if (!summaries) summariesByProgram.set(program, (summaries = createSummaries(program)));
  return summaries;
}

function isTraced(result: TaintResult | undefined): result is TracedResult {
  return !!result?.taint && result.label !== undefined && result.sourceNode !== undefined;
}

function oneLine(text: string, limit: number) {
  const line = text.replaceAll(/\s+/g, ' ').trim();
  return line.length > limit ? line.slice(0, limit - 3) + '...' : line;
}

function step(node: Node): TraceStep {
  const sourceFile = node.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const file = path.relative(process.cwd(), sourceFile.fileName).split(path.sep).join('/');
  return { file, line: line + 1, text: oneLine(node.getText(sourceFile), maxStepTextLength) };
}

function propertyName(access: PropertyAccessExpression | ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(access)) return access.name.text;
  const argument = strip(access.argumentExpression);
  return argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

function declarationOf(identifier: Identifier, checker: CheckerAdapter): Node | undefined {
  const symbol = ts.isShorthandPropertyAssignment(identifier.parent)
    ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
    : checker.getSymbolAtLocation(identifier);
  if (!symbol || symbol.flags & ts.SymbolFlags.Alias) return;
  return symbol.valueDeclaration ?? symbol.declarations?.[0];
}

// `promise.then((value) => ...)`: the promise whose settled value the callback's first parameter
// receives.
function promiseOfThenCallback(fn: Node): Expression | undefined {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return;
  const call = fn.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== fn) return;
  const callee = strip(call.expression);
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'then' ? callee.expression : undefined;
}

// Internal results: { taint } for a tainted value, { container } for a request object whose listed
// fields are tainted, or { parameter: index } for the symbolic parameter of a return summary. Each
// carries steps and hops.
const taintByProgram = new WeakMap<ProgramAdapter, TaintApi>();

function createTaint(program: ProgramAdapter): TaintApi {
  const cached = taintByProgram.get(program);
  if (cached) return cached;
  const checker = program.getTypeChecker();
  const summaries = summariesOf(program);
  const results = new Map<Expression, Map<string, TaintResult | undefined>>();

  function source(taint: TaintResult['taint'], label: string, node: Node, hops: number): TaintResult {
    return { taint, label: oneLine(label, maxLabelLength), sourceNode: node, hops, steps: [step(node)] };
  }

  function archiveSource(found: ParameterSource | undefined, node: Node, hops: number): TaintResult | undefined {
    if (!found) return;
    return { ...found, ...source(found.taint, found.label, node, hops), sourceKind: 'archive-entry' };
  }

  function withStep(result: TaintResult | undefined, node: Node): TaintResult | undefined {
    return result && { ...result, steps: [...result.steps, step(node)] };
  }

  function partOf(result: TaintResult | undefined, keepWhole?: boolean): TaintResult | undefined {
    if (!result || result.container) return result?.container ? undefined : result;
    return keepWhole || result.parameter !== undefined
      ? result
      : { ...result, taint: 'scalar', objectFields: undefined };
  }

  function first(nodes: readonly Expression[], resolveNode: ResolveNext, keepWhole?: boolean): TaintResult | undefined {
    for (const node of nodes) {
      const result = partOf(resolveNode(node), keepWhole);
      if (result) return result;
    }
  }

  function resolve(node: Expression | undefined, state: TaintState): TaintResult | undefined {
    const expression = strip(node);
    if (!expression) return;
    const key = `${state.sinkKind}:${state.hops}:${state.summary?.index ?? ''}`;
    let byKey = results.get(expression);
    if (!byKey) results.set(expression, (byKey = new Map<string, TaintResult | undefined>()));
    if (byKey.has(key)) return byKey.get(key);
    // A cycle (`let a = b; b = a`) resolves to clean.
    byKey.set(key, undefined);
    const result = isPrunedType(expression, checker) ? undefined : resolveExpression(expression, state);
    byKey.set(key, result);
    return result;
  }

  function resolveExpression(expression: Expression, state: TaintState): TaintResult | undefined {
    const next: ResolveNext = (node) => resolve(node, state);
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
      return resolveAccess(expression, next, state);
    if (ts.isIdentifier(expression)) return resolveIdentifier(expression, state);
    if (ts.isCallExpression(expression)) return resolveCall(expression, state);
    if (ts.isNewExpression(expression)) {
      const constructor = strip(expression.expression);
      if (isUrlConstructor(constructor, checker)) return first(expression.arguments ?? [], next);
      if (ts.isIdentifier(constructor) && constructor.text === 'URLSearchParams')
        return partOf(next(expression.arguments?.[0]));
      return;
    }
    if (ts.isObjectLiteralExpression(expression)) return resolveObject(expression, next);
    if (ts.isArrayLiteralExpression(expression)) return first(expression.elements, next);
    if (ts.isSpreadElement(expression)) return next(expression.expression);
  }

  function resolveBinary(expression: BinaryExpression, next: ResolveNext): TaintResult | undefined {
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

  function resolveAccess(
    expression: PropertyAccessExpression | ElementAccessExpression,
    next: ResolveNext,
    state: TaintState,
  ): TaintResult | undefined {
    const name = propertyName(expression);
    if (name === 'length') return;
    const receiver = next(expression.expression);
    if (!receiver) return;
    if (receiver.objectFields) return withStep(objectField(receiver, name), expression);
    if (receiver.container) {
      const field =
        name === undefined || /^\d+$/.test(name) ? receiver.container.element : receiver.container.fields?.[name];
      if (!field) return;
      const label = expression.getText();
      if (field.taint)
        return {
          ...source(field.taint, label, expression, receiver.hops),
          sourceKind: receiver.sourceKind,
          steps: [...receiver.steps, step(expression)],
        };
      return { ...receiver, container: field, label };
    }
    // `req.body` read as `req.body.name`, `@Body() dto` read as `@Body() dto.name`.
    const receiverText = strip(expression.expression).getText();
    const field = fieldOf(receiver, name, state.sinkKind);
    if (!field || !receiver.label) return field;
    if (receiver.label.endsWith(receiverText)) {
      const label = oneLine(receiver.label.slice(0, -receiverText.length) + expression.getText(), maxLabelLength);
      return { ...field, label };
    }
    if (!receiver.hops) return field;
    const suffix = expression.getText().slice(expression.expression.getText().length);
    return withStep({ ...field, label: oneLine(receiver.label + suffix, maxLabelLength) }, expression);
  }

  // A field of a tainted value: clean when validation pinned it (a class-validator DTO property, a
  // closed schema field), the parsed value for a `safeParse(...).data` style wrapper, otherwise a
  // scalar part of the value.
  function fieldOf(receiver: TaintResult, name: string | undefined, sinkKind: SinkKind): TaintResult | undefined {
    if (receiver.wrapper) return name === receiver.wrapper ? { ...receiver, wrapper: undefined } : undefined;
    if (
      receiver.dto &&
      receiver.taint === 'whole' &&
      name !== undefined &&
      validatedField(receiver.dto, name, sinkKind, program, checker)
    )
      return;
    let schema: SchemaShape | undefined;
    if (receiver.schema?.kind === 'object') {
      const fieldSchema = name === undefined ? undefined : receiver.schema.fields?.get(name);
      schema = fieldSchema && schemaShape(fieldSchema, checker);
      if (!schema || schema.kind === 'closed') return;
    }
    const part = partOf(receiver);
    return part && { ...part, schema, dto: undefined };
  }

  // The object is tainted as a whole (for sinks that take it), and each named field keeps its own
  // taint, so
  // `{ filename: tainted, sourcePath }` read back as `.sourcePath` is clean. A tainted spread or
  // computed key taints every field.
  function resolveObject(expression: ObjectLiteralExpression, next: ResolveNext): TaintResult | undefined {
    const fields = new Map<string, TaintResult>();
    let whole: TaintResult | undefined;
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
      const result = value && partOf(next(value), true);
      if (!result) continue;
      whole ??= partOf(result);
      const name = propertyKey(property.name);
      if (name === undefined) return whole;
      fields.set(name, result);
    }
    return whole && { ...whole, objectFields: fields, objectSteps: whole.steps.length };
  }

  // A field of an object literal result, with the steps taken since the literal (call, parameter)
  // appended.
  function objectField(receiver: TaintResult, name: string | undefined): TaintResult | undefined {
    if (name === undefined) return partOf(receiver);
    const field = receiver.objectFields?.get(name);
    return field && { ...field, steps: [...field.steps, ...receiver.steps.slice(receiver.objectSteps)] };
  }

  function resolveIdentifier(identifier: Identifier, state: TaintState): TaintResult | undefined {
    const declaration = declarationOf(identifier, checker);
    if (!declaration) return;
    if (
      !state.summary &&
      (ts.isParameter(declaration) || ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)) &&
      isGuarded(identifier, identifier, checker, state.sinkKind === 'path')
    )
      return;
    if (ts.isParameter(declaration)) return resolveParameter(declaration, state);
    if (ts.isBindingElement(declaration)) return resolveBinding(declaration, state);
    if (ts.isVariableDeclaration(declaration)) return resolveVariable(declaration, identifier, state);
  }

  function resolveParameter(parameter: ParameterDeclaration, state: TaintState): TaintResult | undefined {
    const fn = parameter.parent;
    const index = fn.parameters.indexOf(parameter);
    if (state.summary)
      return state.summary.fn === fn && state.summary.index === index
        ? { parameter: index, steps: [], hops: 0 }
        : undefined;
    if (state.sinkKind === 'archive-path') {
      const archive = archiveSource(archiveParameter(parameter, checker), parameter, state.hops);
      if (archive) return archive;
    }
    const settled = index === 0 && promiseOfThenCallback(fn);
    if (settled) return withStep(resolve(settled, state), parameter);
    const found = state.sinkKind === 'archive-path' ? undefined : parameterSource(parameter, checker);
    if (found === null) return;
    if (found?.container)
      return { container: found.container, label: found.label, hops: state.hops, steps: [step(parameter)] };
    // A whole Nest parameter keeps its declaration, so fields its DTO class validates can be pruned
    // on access.
    if (found) return { ...source(found.taint, found.label, parameter, state.hops), dto: parameter };
    if (state.hops >= maxHops || parameter.dotDotDotToken) return;
    for (const call of summaries.callSites(fn)) {
      const argument = call.arguments[index];
      const result = argument && resolve(argument, { ...state, hops: state.hops + 1 });
      if (result?.taint || result?.sourceKind === 'archive-entry')
        return { ...result, steps: [...result.steps, step(call), step(parameter)] };
    }
  }

  // `const { body: { name } } = req`: the property path below the bound value, outermost first.
  function resolveBinding(element: BindingElement, state: TaintState): TaintResult | undefined {
    const names: BindingPathSegment[] = [];
    let current: BindingElement | ParameterDeclaration | VariableDeclaration = element;
    while (ts.isBindingElement(current)) {
      const pattern: BindingPattern = current.parent;
      prependBindingPathSegment(current, names, pattern);
      current = pattern.parent;
    }
    let result: TaintResult | undefined;
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
              sourceKind: result.sourceKind,
              steps: [...result.steps, step(element)],
            }
          : { ...result, container: field };
      } else if (result.objectFields) result = name === null ? result : objectField(result, name);
      else result = boundField(result, name, state.sinkKind);
    }
    return withStep(result, element);
  }

  // A destructured field of a value that crossed a call: the helper's parameter name means nothing
  // at the source, so the label keeps the request path (`save(req.body)` into `({ name })` reads
  // `req.body.name`), as a property read does. A `safeParse(...)` wrapper's `data` is the parsed
  // value itself, so its label stays.
  function boundField(receiver: TaintResult, name: string | undefined, sinkKind: SinkKind): TaintResult | undefined {
    const field = fieldOf(receiver, name, sinkKind);
    if (!field || !receiver.hops || !receiver.label || receiver.wrapper || name === undefined) return field;
    return { ...field, label: oneLine(`${receiver.label}.${name}`, maxLabelLength) };
  }

  // `for (const item of items)`: an element of the iterated value.
  function resolveLoopVariable(declaration: VariableDeclaration, state: TaintState): TaintResult | undefined {
    const loop = declaration.parent.parent;
    if (!ts.isForOfStatement(loop) && !ts.isForInStatement(loop)) return;
    if (state.sinkKind === 'archive-path') {
      const archive = archiveSource(archiveLoopEntry(declaration, checker), declaration, state.hops);
      if (archive) return archive;
    }
    const iterated = resolve(loop.expression, state);
    if (iterated?.container) {
      const element = iterated.container.element;
      return element && { container: element, label: iterated.label, hops: iterated.hops, steps: iterated.steps };
    }
    return partOf(iterated);
  }

  function resolveVariable(
    declaration: VariableDeclaration,
    identifier: Identifier,
    state: TaintState,
  ): TaintResult | undefined {
    if (!declaration.initializer) {
      const loop = resolveLoopVariable(declaration, state);
      if (loop || declaration.parent.flags & ts.NodeFlags.Const) return withStep(loop, declaration);
    } else {
      const initial = resolve(declaration.initializer, state);
      if (initial || declaration.parent.flags & ts.NodeFlags.Const) return withStep(initial, declaration);
    }
    // `let` and `var`: any write in the same function can taint the variable.
    const scope = ts.findAncestor(declaration, (node: Node) => ts.isFunctionLike(node) || ts.isSourceFile(node));
    if (!scope) return;
    for (const assignment of assignmentsTo(declaration, scope, checker)) {
      if (assignment.left === identifier) continue;
      const assigned = withStep(partOf(resolve(assignment.right, state), true), assignment);
      if (assigned) return assigned;
    }
  }

  function resolveCall(call: CallExpression, state: TaintState): TaintResult | undefined {
    if (isNumericCall(call)) return;
    if (state.sinkKind === 'regex' && isRegexEscape(call, checker)) return;
    const callee = strip(call.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const receiver = resolve(callee.expression, state);
      const returned = receiver?.container?.calls?.[callee.name.text];
      if (receiver && returned)
        return {
          ...source(returned.taint, call.getText(), call, receiver.hops),
          steps: [...receiver.steps, step(call)],
        };
      // `new URL(input).searchParams.get('next')`
      const searched = strip(callee.expression);
      if (
        ['get', 'getAll'].includes(callee.name.text) &&
        ts.isPropertyAccessExpression(searched) &&
        searched.name.text === 'searchParams'
      )
        return partOf(receiver);
    }
    const h3 = h3SourceCall(call, checker);
    if (h3) return { ...source(h3.taint, h3.label, call, state.hops), steps: [step(call)] };
    const validated = schemaCall(call, checker);
    if (validated) return resolveValidated(call, validated, state);
    if (isSanitizingCall(call, state.sinkKind)) return;
    const propagated = propagation(call, checker);
    if (propagated) return resolvePropagation(call, callee, propagated, state);
    if (state.summary) return;
    const fn = summaries.localCallee(call);
    if (!fn) return;
    const indexes = summaries.returnSummary(fn, state.sinkKind, (expression: Expression, index: number) =>
      Boolean(resolve(expression, { sinkKind: state.sinkKind, hops: 0, summary: { fn, index } })),
    );
    for (const index of indexes) {
      const argument = call.arguments[index];
      const result = argument && partOf(resolve(argument, state), true);
      if (result) return withStep(result, call);
    }
  }

  // A project helper that returns its validated argument, or a literal fallback, returns clean
  // data.
  function isSanitizingCall(call: CallExpression, sinkKind: SinkKind) {
    const kinds = sanitizedKinds.get(sinkKind);
    return Boolean(
      kinds && argumentValidations(call, program).some(({ kind, mode }) => mode === 'returns' && kinds.includes(kind)),
    );
  }

  // A schema that only admits numbers, booleans, dates, fixed values or a closed alphabet returns
  // clean data; an open schema (`z.string()`) returns its input. A schema that cannot be read is an
  // unknown call, so clean.
  function resolveValidated(
    call: CallExpression,
    { input, schema, wrapper }: SchemaCall,
    state: TaintState,
  ): TaintResult | undefined {
    const shape = schema && schemaShape(schema, checker);
    if (!shape || shape.kind === 'closed' || !input) return;
    const result = partOf(resolve(input, state), true);
    return result && withStep({ ...result, schema: shape, wrapper, dto: undefined }, call);
  }

  function resolvePropagation(
    call: CallExpression,
    callee: Expression,
    { from, name, stringResult }: Propagation,
    state: TaintState,
  ): TaintResult | undefined {
    if (stringIsSafe(state.sinkKind) && (name === 'String' || stringResult)) return;
    if (from === 'receiver')
      return ts.isPropertyAccessExpression(callee) ? partOf(resolve(callee.expression, state)) : undefined;
    const keepWhole = from === 'keep' || from === 'keep-any';
    const inputs = from === 'any' || from === 'keep-any' ? call.arguments : call.arguments.slice(0, 1);
    return first(inputs, (node) => resolve(node, state), keepWhole);
  }

  function publicTrace(result: TracedResult, expression: Expression): Trace {
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
      sourceKind: result.sourceKind ?? 'request',
      hops: result.hops,
      whole: result.taint === 'whole',
      shape,
      steps: result.steps,
    };
  }

  function trace(expression: Expression, sinkKind: SinkKind): Trace | undefined {
    if (!sinkKinds.has(sinkKind)) throw new Error('Unknown sink kind: ' + sinkKind);
    const result = resolve(expression, { sinkKind, hops: 0 });
    return isTraced(result) ? publicTrace(result, strip(expression)) : undefined;
  }

  function isUntracedParameter(expression: Expression): boolean {
    let node: Expression | undefined = strip(expression);
    const visited = new Set<Node>();
    while (node && ts.isIdentifier(node) && !visited.has(node)) {
      visited.add(node);
      const declaration = declarationOf(node, checker);
      if (!declaration) return false;
      if (ts.isParameter(declaration)) {
        return parameterSource(declaration, checker) === undefined && !resolve(node, { sinkKind: 'code', hops: 0 });
      }
      node =
        ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const
          ? strip(declaration.initializer)
          : undefined;
    }
    return false;
  }

  const api: TaintApi = { trace, isUntracedParameter, urlControl: createUrlControl(checker, trace, strip) };
  taintByProgram.set(program, api);
  return api;
}

function propertyKey(name: PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
}

function prependBindingPathSegment(
  current: BindingElement,
  names: BindingPathSegment[],
  pattern: BindingPattern,
): void {
  if (current.dotDotDotToken) names.unshift(null);
  else if (ts.isArrayBindingPattern(pattern)) names.unshift(undefined);
  else {
    const property = current.propertyName ?? current.name;
    names.unshift(ts.isIdentifier(property) || ts.isStringLiteralLike(property) ? property.text : undefined);
  }
}

export { createTaint };
