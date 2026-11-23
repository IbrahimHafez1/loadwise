'use strict';

// `nosql-operator-injection`: request data that can arrive as an object (`{ "$ne": null }`) used as a MongoDB filter
// or filter value on a Mongoose model or a MongoDB collection, and request text used as a `$where` expression.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { reportTraced, methodName, createdBy, calledExport, initializerOf } = require('./shared.cjs');
const { isProjectSource, returnedExpressions } = require('../taint/summaries.cjs');

const ruleId = 'nosql-operator-injection';
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
// Request parts that a body parser or query-string parser can turn into objects. Route parameters, headers, URLs
// and `request.text()` are always strings.
const objectCapableSource =
  /\.(?:body|query|cookies|signedCookies|input)\b|\.(?:json|parseBody|formData|queries)\(|^\s*\{?\s*input\b|@(?:Body|Query|Args|MessageBody)\(/;

function message(label) {
  return `\`${label}\` is used as a MongoDB filter value and can be an object such as \`{ "$ne": null }\`, changing what the query matches. Pass \`String(value)\` or wrap it as \`{ $eq: value }\`, or validate the body with a schema.`;
}

function whereMessage(label) {
  return `\`${label}\` is used as a MongoDB \`$where\` expression, which runs as JavaScript on the database server. Express the condition with query operators and pass the value as data.`;
}

const sanitizerByProgram = new WeakMap();

// A dependency alone provides no evidence the middleware runs. Even when registered, confirm route and order.
function sanitizerReason(context) {
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

function hasSanitizerRegistration(source, context) {
  if (source.isDeclarationFile || !source.text.includes(sanitizerModule)) return false;
  function callsFactory(node, module, exports) {
    if (!ts.isCallExpression(node)) return false;
    const binding = context.libraryCall(node);
    return binding?.module === module && exports.has(calledExport(binding));
  }
  function isExpressUse(call) {
    if (methodName(call) !== 'use') return false;
    const receiver = ts.skipOuterExpressions(call.expression).expression;
    return (
      context.libraryCall(call)?.module === 'express' ||
      createdBy(receiver, (factory) => callsFactory(factory, 'express', expressFactoryExports), context.checker)
    );
  }
  function usesSanitizer(node) {
    return (
      (ts.isCallExpression(node) &&
        isExpressUse(node) &&
        node.arguments.some((argument) =>
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

function isMongooseModelFactory(created, context) {
  if (!ts.isCallExpression(created)) return false;
  const library = context.libraryCall(created);
  return library?.module === 'mongoose' && calledExport(library) === 'model';
}

// `db.collection('users')` (MongoDB `Db`) or `new MarsDB.Collection('orders')`: a collection named by a literal.
function isNamedCollection(created) {
  const callee = ts.skipOuterExpressions(created.expression);
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
  const [collectionName] = created.arguments ?? [];
  const named = collectionName !== undefined && ts.isStringLiteralLike(ts.skipOuterExpressions(collectionName));
  if (ts.isNewExpression(created)) return named && name === 'Collection';
  return named && ts.isPropertyAccessExpression(callee) && name === 'collection';
}

// A Mongoose model or MongoDB collection: typed or annotated (`Model<User>`, `Collection<T>`), a value created
// by `mongoose.model(...)` here or in the module it was imported from, or a collection named by a literal. Firestore
// collections are also named that way, but they filter with `where`, which a MongoDB collection does not have.
function isMongoReceiver(call, context, method) {
  if (mongoModules.has(context.libraryCall(call)?.module)) return true;
  const receiver = ts.skipOuterExpressions(call.expression).expression;
  return createdBy(
    receiver,
    (created) => isMongooseModelFactory(created, context) || (method !== 'where' && isNamedCollection(created)),
    context.checker,
  );
}

function filterArguments(call, method) {
  if (filterFirstMethods.has(method)) return [call.arguments[0]];
  if (method === 'distinct') return [call.arguments[1]];
  if (method !== 'aggregate') return [];
  const pipeline = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  if (!pipeline || !ts.isArrayLiteralExpression(pipeline)) return [];
  return pipeline.elements.flatMap((stage) => {
    const value = ts.skipOuterExpressions(stage);
    if (!ts.isObjectLiteralExpression(value)) return [];
    const match = value.properties.find((property) => propertyKey(property) === '$match');
    return match && ts.isPropertyAssignment(match) ? [match.initializer] : [];
  });
}

function propertyKey(property) {
  const name = property.name;
  if (!name) return;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

// A trace from a request part a parser can turn into an object, at a sink whose static type is not `string`.
// A declared `string` comes from a DTO, a schema type or a validated service signature (security design 2.4).
function isObjectCapable(trace) {
  if (trace.shape === 'string') return false;
  return [trace.label, ...trace.steps.slice(0, 2).map((item) => item.text)].some((text) =>
    objectCapableSource.test(text),
  );
}

// The values a filter value can take: both branches of `a ? b : c` (also behind a `const`), else the value itself.
function valueLeaves(node, checker, depth = 0) {
  const value = ts.skipOuterExpressions(node);
  if (depth >= maxBranchDepth) return [value];
  const initializer = ts.isIdentifier(value) ? initializerOf(value, checker) : undefined;
  const branching = initializer && ts.isConditionalExpression(initializer) ? initializer : value;
  if (!ts.isConditionalExpression(branching)) return [value];
  return [branching.whenTrue, branching.whenFalse].flatMap((branch) => valueLeaves(branch, checker, depth + 1));
}

function reportValue(node, context, contextualReason) {
  for (const leaf of valueLeaves(node, context.checker)) {
    // An object or array built here is an operator expression the code chose, such as `{ $in: ids }`.
    if (ts.isObjectLiteralExpression(leaf) || ts.isArrayLiteralExpression(leaf)) continue;
    const trace = context.taint.trace(leaf, 'nosql');
    if (!trace || !isObjectCapable(trace)) continue;
    return reportTraced(context, node, ruleId, message(trace.label), trace, contextualReason);
  }
}

function reportWhere(value, context, contextualReason) {
  const trace = context.taint.trace(value, 'code');
  if (trace) reportTraced(context, value, ruleId, whereMessage(trace.label), trace, contextualReason);
}

function checkFilterObject(filter, context, contextualReason) {
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
    if (!ts.isPropertyAssignment(property)) continue;
    const value = ts.skipOuterExpressions(property.initializer);
    if (key === '$where') {
      reportWhere(value, context, contextualReason);
      continue;
    }
    if (logicalOperators.has(key) && ts.isArrayLiteralExpression(value)) {
      checkLogicalFilterBranches(value, context, contextualReason);
      continue;
    }
    // A nested object is an operator expression (`{ $eq: value }`) or an exact sub-document match.
    if (key?.startsWith('$') || ts.isObjectLiteralExpression(value)) continue;
    reportValue(value, context, contextualReason);
  }
}

function checkLogicalFilterBranches(value, context, contextualReason) {
  for (const element of value.elements) {
    const branch = ts.skipOuterExpressions(element);
    if (ts.isObjectLiteralExpression(branch)) checkFilterObject(branch, context, contextualReason);
  }
}

function checkFilter(filter, context) {
  if (!filter || ts.isSpreadElement(filter)) return;
  const reason = sanitizerReason(context);
  const value = ts.skipOuterExpressions(filter);
  if (ts.isObjectLiteralExpression(value)) return checkFilterObject(value, context, reason);
  for (const built of builtFilters(value, context)) checkFilterObject(built, context, reason);
  reportWhole(value, context, reason);
}

// `find(searchCriteria())`: the object literals a project function without parameters returns as the filter.
function builtFilters(value, context) {
  if (!ts.isCallExpression(value) || value.arguments.length) return [];
  const fn = context.checker.getResolvedSignature(value)?.declaration;
  if (!fn || !ts.isFunctionLike(fn) || !fn.body || fn.parameters.length || !isProjectSource(fn.getSourceFile()))
    return [];
  return (returnedExpressions(fn) ?? [])
    .map((expression) => ts.skipOuterExpressions(expression))
    .filter((expression) => ts.isObjectLiteralExpression(expression));
}

// `$where` runs JavaScript on MongoDB-compatible stores only, so request text in it is reported on any receiver.
function checkWhereOnly(filter, context) {
  const value = filter && ts.skipOuterExpressions(filter);
  if (!value || !ts.isObjectLiteralExpression(value)) return;
  for (const property of value.properties)
    if (ts.isPropertyAssignment(property) && propertyKey(property) === '$where')
      reportWhere(ts.skipOuterExpressions(property.initializer), context, sanitizerReason(context));
}

// The whole request object (`req.body`, `@Query() query`) is the filter or is spread into it.
function reportWhole(node, context, contextualReason) {
  const trace = context.taint.trace(node, 'nosql');
  if (!trace?.whole || !isObjectCapable(trace)) return;
  reportTraced(context, node, ruleId, message(trace.label), trace, contextualReason);
}

function check(call, context) {
  const method = methodName(call);
  if (!method) return;
  const filters = filterArguments(call, method).filter(Boolean);
  if (!filters.length) return;
  if (!isMongoReceiver(call, context, method)) return filters.forEach((filter) => checkWhereOnly(filter, context));
  for (const filter of filters) checkFilter(filter, context);
}

module.exports = { check, ruleId };
