// `nosql-operator-injection`: request data that can arrive as an object (`{ "$ne": null }`) used as
// a MongoDB filter or filter value on a Mongoose model or a MongoDB collection, and request text
// used as a `$where` expression.
import { ts } from '../../performance/compiler.js';
import { reportTraced, methodName, createdBy, calledExport, initializerOf, fieldWritesOf } from './shared.js';
import { isProjectSource, returnedExpressions } from '../taint/summaries.js';
import type {
  ArrayLiteralExpression,
  CallExpression,
  Expression,
  NewExpression,
  Node,
  ObjectLiteralElementLike,
  ObjectLiteralExpression,
  SourceFile,
} from 'typescript';
import type { CheckerAdapter, ProgramAdapter, SecurityRuleContext, Trace } from '../../shared/types.js';

const ruleId = 'nosql-operator-injection';
const stageAddingMethods = new Set(['push', 'unshift']);
const filterFirstMethods = new Set([
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndRemove',
  'findOneAndReplace',
  'countDocuments',
  'count',
  'exists',
  'updateOne',
  'updateMany',
  'update',
  'deleteOne',
  'deleteMany',
  'remove',
  'replaceOne',
  'where',
]);
const mongoModules = new Set(['mongoose', 'mongodb']);
const sanitizerModule = 'express-mongo-sanitize';
const expressFactoryExports = new Set(['default', '*', 'Router']);
const sanitizerFactoryExports = new Set(['default', '*']);
const logicalOperators = new Set(['$or', '$and', '$nor']);
const maxBranchDepth = 3;
// Request parts that a body parser or query-string parser can turn into objects. Route parameters,
// headers, URLs and `request.text()` are always strings.
const objectCapableSource =
  /\.(?:body|query|cookies|signedCookies|input)\b|\.(?:json|parseBody|formData|queries)\(|^\s*\{?\s*input\b|@(?:Body|Query|Args|MessageBody)\(/;

function message(label: string) {
  return `\`${label}\` is used as a MongoDB filter value and can be an object such as \`{ "$ne": null }\`, changing what the query matches. Pass \`String(value)\` or wrap it as \`{ $eq: value }\`, or validate the body with a schema.`;
}

function whereMessage(label: string) {
  return `\`${label}\` is used as a MongoDB \`$where\` expression, which runs as JavaScript on the database server. Express the condition with query operators and pass the value as data.`;
}

const sanitizerByProgram = new WeakMap<ProgramAdapter, boolean | undefined>();

// A dependency alone provides no evidence the middleware runs. Even when registered, confirm route
// and order.
function sanitizerReason(context: SecurityRuleContext): string | undefined {
  const { program } = context;
  if (!program) return;
  if (!sanitizerByProgram.has(program)) {
    sanitizerByProgram.set(
      program,
      (program.getSourceFiles?.() ?? program.getToolingSourceFiles?.() ?? []).some((source) =>
        hasSanitizerRegistration(source, context),
      ),
    );
  }
  if (sanitizerByProgram.get(program)) {
    return `A visible Express app registers \`${sanitizerModule}\`; confirm it runs before this handler and covers its request values.`;
  }
}

function hasSanitizerRegistration(source: SourceFile, context: SecurityRuleContext): boolean | undefined {
  if (source.isDeclarationFile || !source.text.includes(sanitizerModule)) return false;
  function callsFactory(node: Node, module: string, acceptedExports: ReadonlySet<string>) {
    if (!ts.isCallExpression(node)) return false;
    const binding = context.libraryCall(node);
    const exported = calledExport(binding);
    return binding?.module === module && exported !== undefined && acceptedExports.has(exported);
  }
  function isExpressUse(call: CallExpression) {
    if (methodName(call) !== 'use') return false;
    const callee = ts.skipOuterExpressions(call.expression);
    if (!ts.isPropertyAccessExpression(callee)) return false;
    const receiver = callee.expression;
    return (
      context.libraryCall(call)?.module === 'express' ||
      createdBy(receiver, (factory) => callsFactory(factory, 'express', expressFactoryExports), context.checker)
    );
  }
  function usesSanitizer(node: Node): boolean | undefined {
    return (
      (ts.isCallExpression(node) &&
        isExpressUse(node) &&
        node.arguments.some((argument: Expression) =>
          createdBy(
            argument,
            (factory) => callsFactory(factory, sanitizerModule, sanitizerFactoryExports),
            context.checker,
          ),
        )) ||
      ts.forEachChild(node, usesSanitizer)
    );
  }
  return usesSanitizer(source);
}

function isMongooseModelFactory(created: CallExpression | NewExpression, context: SecurityRuleContext) {
  if (!ts.isCallExpression(created)) return false;
  const library = context.libraryCall(created);
  return library?.module === 'mongoose' && calledExport(library) === 'model';
}

// `db.collection('users')` (MongoDB `Db`) or `new MarsDB.Collection('orders')`: a collection named
// by a literal.
function isNamedCollection(created: CallExpression | NewExpression) {
  const callee = ts.skipOuterExpressions(created.expression);
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
  const [collectionName] = created.arguments ?? [];
  const named = collectionName !== undefined && ts.isStringLiteralLike(ts.skipOuterExpressions(collectionName));
  if (ts.isNewExpression(created)) return named && name === 'Collection';
  return named && ts.isPropertyAccessExpression(callee) && name === 'collection';
}

// A Mongoose model or MongoDB collection: typed or annotated (`Model<User>`, `Collection<T>`), a
// value created by `mongoose.model(...)` here or in the module it was imported from, or a
// collection named by a literal. Firestore collections are also named that way, but they filter
// with `where`, which a MongoDB collection does not have.
function isMongoReceiver(call: CallExpression, context: SecurityRuleContext, method: string) {
  const module = context.libraryCall(call)?.module;
  if (module !== undefined && mongoModules.has(module)) return true;
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  return createdBy(
    callee.expression,
    (created) => isMongooseModelFactory(created, context) || (method !== 'where' && isNamedCollection(created)),
    context.checker,
  );
}

// An identifier initialized from a literal (`const pipeline = [...]`) stands for that literal.
function resolveLocalLiteral(node: Expression, checker: CheckerAdapter): Expression {
  const value = ts.skipOuterExpressions(node);
  const initializer = ts.isIdentifier(value) ? initializerOf(value, checker) : undefined;
  return initializer ? ts.skipOuterExpressions(initializer) : value;
}

function filterArguments(call: CallExpression, method: string, checker: CheckerAdapter): (Expression | undefined)[] {
  if (filterFirstMethods.has(method)) return [call.arguments[0]];
  if (method === 'distinct') return [call.arguments[1]];
  if (method !== 'aggregate') return [];
  const pipeline = call.arguments[0] && resolveLocalLiteral(call.arguments[0], checker);
  if (!pipeline || !ts.isArrayLiteralExpression(pipeline)) return [];
  const stages = [...pipeline.elements, ...pushedStages(call.arguments[0], call, checker)];
  return stages.flatMap((stage) => {
    const value = ts.skipOuterExpressions(stage);
    if (!ts.isObjectLiteralExpression(value)) return [];
    const match = value.properties.find((property) => propertyKey(property) === '$match');
    return match && ts.isPropertyAssignment(match) ? [match.initializer] : [];
  });
}

// `pipeline.push(stage)` after `const pipeline = [...]`: the stages added to a local pipeline
// before `aggregate` runs it.
function pushedStages(node: Expression, aggregate: CallExpression, checker: CheckerAdapter): Expression[] {
  const value = ts.skipOuterExpressions(node);
  const declaration = ts.isIdentifier(value) ? checker.getSymbolAtLocation(value)?.valueDeclaration : undefined;
  const scope =
    declaration && ts.findAncestor(declaration, (child: Node) => ts.isFunctionLike(child) || ts.isSourceFile(child));
  if (!scope) return [];
  const stages: Expression[] = [];
  (function visit(child: Node): void {
    if (
      ts.isCallExpression(child) &&
      ts.isPropertyAccessExpression(child.expression) &&
      stageAddingMethods.has(child.expression.name.text)
    ) {
      const receiver = ts.skipOuterExpressions(child.expression.expression);
      if (
        ts.isIdentifier(receiver) &&
        checker.getSymbolAtLocation(receiver)?.valueDeclaration === declaration &&
        runsBefore(child, aggregate, declaration)
      )
        stages.push(...child.arguments);
    }
    ts.forEachChild(child, visit);
  })(scope);
  return stages;
}

// A push written after the call reaches it only on a later pass of a loop around both that keeps
// the same pipeline. Any such loop counts, not just the innermost one around the call.
function runsBefore(push: Node, aggregate: CallExpression, declaration: Node) {
  if (push.getStart() < aggregate.getStart()) return true;
  for (let node: Node | undefined = aggregate.parent; node && !encloses(node, declaration); node = node.parent)
    if (ts.isIterationStatement(node, false) && encloses(node, push)) return true;
  return false;
}

function encloses(outer: Node, inner: Node) {
  return outer.getStart() <= inner.getStart() && inner.getEnd() <= outer.getEnd();
}

function propertyKey(property: ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  if (!name) return;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

// A trace from a request part a parser can turn into an object, at a sink whose static type is not
// `string`. A declared `string` comes from a DTO, a schema type or a validated service signature
// (security design 2.4).
function isObjectCapable(trace: Trace) {
  if (trace.shape === 'string') return false;
  return [trace.label, ...trace.steps.slice(0, 2).map((item) => item.text)].some((text) =>
    objectCapableSource.test(text),
  );
}

// The values a filter value can take: both branches of `a ? b : c` (also behind a `const`), else
// the value itself.
function valueLeaves(node: Expression, checker: CheckerAdapter, depth = 0): Expression[] {
  const value = ts.skipOuterExpressions(node);
  if (depth >= maxBranchDepth) return [value];
  const initializer = ts.isIdentifier(value) ? initializerOf(value, checker) : undefined;
  const branching = initializer && ts.isConditionalExpression(initializer) ? initializer : value;
  if (!ts.isConditionalExpression(branching)) return [value];
  return [branching.whenTrue, branching.whenFalse].flatMap((branch) => valueLeaves(branch, checker, depth + 1));
}

function reportValue(node: Expression, context: SecurityRuleContext, contextualReason?: string) {
  for (const leaf of valueLeaves(node, context.checker)) {
    // An object or array built here is an operator expression the code chose, such as `{ $in: ids
    // }`.
    if (ts.isObjectLiteralExpression(leaf) || ts.isArrayLiteralExpression(leaf)) continue;
    const trace = context.taint.trace(leaf, 'nosql');
    if (!trace || !isObjectCapable(trace)) continue;
    return reportTraced(context, node, ruleId, message(trace.label), trace, contextualReason);
  }
}

function reportWhere(value: Expression, context: SecurityRuleContext, contextualReason?: string) {
  const trace = context.taint.trace(value, 'code');
  if (trace) reportTraced(context, value, ruleId, whereMessage(trace.label), trace, contextualReason);
}

function checkFilterObject(filter: ObjectLiteralExpression, context: SecurityRuleContext, contextualReason?: string) {
  for (const property of filter.properties) {
    const key = propertyKey(property);
    if (ts.isSpreadAssignment(property)) {
      reportWhole(property.expression, context, contextualReason);
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      reportValue(property.name, context, contextualReason);
      continue;
    }
    if (ts.isPropertyAssignment(property)) checkFilterField(key, property.initializer, context, contextualReason);
  }
}

// One `key: value` of a filter, written in the literal or assigned later (`filter.$where = ...`).
function checkFilterField(
  key: string | undefined,
  initializer: Expression,
  context: SecurityRuleContext,
  contextualReason?: string,
) {
  const value = ts.skipOuterExpressions(initializer);
  if (key === '$where') return reportWhere(value, context, contextualReason);
  if (key !== undefined && logicalOperators.has(key) && ts.isArrayLiteralExpression(value))
    return checkLogicalFilterBranches(value, context, contextualReason);
  // A nested object is an operator expression (`{ $eq: value }`) or an exact sub-document match, so
  // only a spread request object, whose keys become operators, is reported inside it.
  if (ts.isObjectLiteralExpression(value)) return reportNestedSpreads(value, context, contextualReason);
  // `{ $or: req.body.branches }`: a value the request supplies under an operator key is as
  // attacker-shaped as a top-level one.
  reportValue(value, context, contextualReason);
}

function reportNestedSpreads(nested: ObjectLiteralExpression, context: SecurityRuleContext, contextualReason?: string) {
  for (const property of nested.properties)
    if (ts.isSpreadAssignment(property)) reportWhole(property.expression, context, contextualReason);
}

function checkLogicalFilterBranches(
  value: ArrayLiteralExpression,
  context: SecurityRuleContext,
  contextualReason?: string,
) {
  for (const element of value.elements) {
    const branch = ts.skipOuterExpressions(element);
    // `const branch = { name: req.body.name }; find({ $or: [branch] })` gets the inline checks.
    const literal = resolveLocalLiteral(branch, context.checker);
    if (!ts.isObjectLiteralExpression(literal)) {
      reportWhole(branch, context, contextualReason);
      continue;
    }
    checkFilterObject(literal, context, contextualReason);
    if (ts.isIdentifier(branch))
      for (const { name, assignment } of fieldWritesOf(branch, context.checker))
        checkFilterField(name, assignment.right, context, contextualReason);
  }
}

function checkFilter(filter: Expression, context: SecurityRuleContext) {
  if (!filter || ts.isSpreadElement(filter)) return;
  const reason = sanitizerReason(context);
  const value = ts.skipOuterExpressions(filter);
  if (ts.isObjectLiteralExpression(value)) return checkFilterObject(value, context, reason);
  const local = ts.isIdentifier(value) ? initializerOf(value, context.checker) : undefined;
  const localFilter = local && ts.skipOuterExpressions(local);
  if (localFilter && ts.isObjectLiteralExpression(localFilter) && ts.isIdentifier(value)) {
    checkFilterObject(localFilter, context, reason);
    for (const { name, assignment } of fieldWritesOf(value, context.checker))
      checkFilterField(name, assignment.right, context, reason);
  }
  for (const built of builtFilters(value, context)) checkFilterObject(built, context, reason);
  reportWhole(value, context, reason);
}

// `find(searchCriteria())`: the object literals a project function without parameters returns as
// the filter.
function builtFilters(value: Expression, context: SecurityRuleContext): ObjectLiteralExpression[] {
  if (!ts.isCallExpression(value) || value.arguments.length) return [];
  const fn = context.checker.getResolvedSignature(value)?.declaration;
  if (
    !fn ||
    !ts.isFunctionLike(fn) ||
    !('body' in fn && fn.body) ||
    fn.parameters.length ||
    !isProjectSource(fn.getSourceFile())
  )
    return [];
  return (returnedExpressions(fn) ?? [])
    .map((expression) => ts.skipOuterExpressions(expression))
    .filter((expression): expression is ObjectLiteralExpression => ts.isObjectLiteralExpression(expression));
}

// `$where` runs JavaScript on MongoDB-compatible stores only, so request text in it is reported on
// any receiver.
function checkWhereOnly(filter: Expression, context: SecurityRuleContext) {
  const value = filter && ts.skipOuterExpressions(filter);
  if (!value || !ts.isObjectLiteralExpression(value)) return;
  for (const property of value.properties)
    if (ts.isPropertyAssignment(property) && propertyKey(property) === '$where')
      reportWhere(ts.skipOuterExpressions(property.initializer), context, sanitizerReason(context));
}

// The whole request object (`req.body`, `@Query() query`) is the filter or is spread into it.
function reportWhole(node: Expression, context: SecurityRuleContext, contextualReason?: string) {
  const trace = context.taint.trace(node, 'nosql');
  if (!trace?.whole || !isObjectCapable(trace)) return;
  reportTraced(context, node, ruleId, message(trace.label), trace, contextualReason);
}

function check(call: CallExpression, context: SecurityRuleContext) {
  const method = methodName(call);
  if (!method) return;
  const filters = filterArguments(call, method, context.checker).filter(
    (filter): filter is Expression => filter !== undefined,
  );
  if (!filters.length) return;
  if (!isMongoReceiver(call, context, method)) return filters.forEach((filter) => checkWhereOnly(filter, context));
  for (const filter of filters) checkFilter(filter, context);
  // Mongoose `where(path, value)`: the second argument is the path's condition.
  const [, condition] = call.arguments;
  if (method !== 'where' || call.arguments.length !== 2 || !condition) return;
  // `where('name', { ...req.body })` spreads request keys into the condition, as in `find`.
  const conditionValue = ts.skipOuterExpressions(condition);
  if (ts.isObjectLiteralExpression(conditionValue))
    reportNestedSpreads(conditionValue, context, sanitizerReason(context));
  else reportValue(condition, context, sanitizerReason(context));
}

export { check, ruleId };
