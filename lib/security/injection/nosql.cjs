'use strict';

// `nosql-operator-injection`: request data that can arrive as an object (`{ "$ne": null }`) used as a MongoDB filter
// or filter value on a Mongoose model or a MongoDB collection, and request text used as a `$where` expression.
const fs = require('node:fs');
const path = require('node:path');
const { syntax: ts } = require('../../performance/compiler.cjs');
const { reportTraced, methodName, createdBy, calledExport, initializerOf } = require('./shared.cjs');

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
const sanitizerPackages = ['express-mongo-sanitize', 'mongo-sanitize'];
const logicalOperators = new Set(['$or', '$and', '$nor']);
const stringMethods = new Set([
  'toLowerCase',
  'toUpperCase',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'trim',
  'trimStart',
  'trimEnd',
  'slice',
  'substring',
  'substr',
  'replace',
  'replaceAll',
  'padStart',
  'padEnd',
  'normalize',
  'toString',
  'split',
]);
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

const sanitizerReasonsByDirectory = new Map();

// The project depends on a middleware that strips `$` keys from request data; it is usually registered globally.
function sanitizerReason(sourceFile) {
  let directory = path.dirname(sourceFile.fileName);
  const visited = [];
  let reason;
  while (!sanitizerReasonsByDirectory.has(directory)) {
    visited.push(directory);
    const manifest = path.join(directory, 'package.json');
    if (fs.existsSync(manifest)) {
      reason = manifestReason(manifest);
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (sanitizerReasonsByDirectory.has(directory)) reason = sanitizerReasonsByDirectory.get(directory);
  for (const each of visited) sanitizerReasonsByDirectory.set(each, reason);
  return reason;
}

function manifestReason(manifest) {
  let dependencies;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    dependencies = { ...parsed.dependencies, ...parsed.devDependencies };
  } catch {
    return;
  }
  const found = sanitizerPackages.find((name) => Object.hasOwn(dependencies, name));
  return (
    found &&
    `The project depends on \`${found}\`, which strips \`$\` keys from request data when it runs before this handler; confirm it is registered for this route.`
  );
}

function isMongooseModelFactory(created, context) {
  if (!ts.isCallExpression(created)) return false;
  const library = context.libraryCall(created);
  return library?.module === 'mongoose' && calledExport(library) === 'model';
}

// A Mongoose model or MongoDB collection: typed or annotated (`Model<User>`, `Collection<T>`), or a value created
// by `mongoose.model(...)` here or in the module it was imported from.
function isMongoReceiver(call, context) {
  if (mongoModules.has(context.libraryCall(call)?.module)) return true;
  const receiver = ts.skipOuterExpressions(call.expression).expression;
  return createdBy(receiver, (created) => isMongooseModelFactory(created, context), context.checker);
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

// `value.toLowerCase()`: a string method either returns a string or throws on an object.
function producesString(value) {
  return ts.isCallExpression(value) && stringMethods.has(methodName(value));
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
    if (ts.isObjectLiteralExpression(leaf) || ts.isArrayLiteralExpression(leaf) || producesString(leaf)) continue;
    const trace = context.taint.trace(leaf, 'nosql');
    if (!trace || !isObjectCapable(trace)) continue;
    return reportTraced(context, node, ruleId, message(trace.label), trace, contextualReason);
  }
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
      const trace = context.taint.trace(value, 'code');
      if (trace) reportTraced(context, value, ruleId, whereMessage(trace.label), trace, contextualReason);
      continue;
    }
    if (logicalOperators.has(key) && ts.isArrayLiteralExpression(value)) {
      for (const element of value.elements) {
        const branch = ts.skipOuterExpressions(element);
        if (ts.isObjectLiteralExpression(branch)) checkFilterObject(branch, context, contextualReason);
      }
      continue;
    }
    // A nested object is an operator expression (`{ $eq: value }`) or an exact sub-document match.
    if (key?.startsWith('$') || ts.isObjectLiteralExpression(value)) continue;
    reportValue(value, context, contextualReason);
  }
}

function checkFilter(filter, context) {
  if (!filter || ts.isSpreadElement(filter)) return;
  const reason = sanitizerReason(context.sourceFile);
  const value = ts.skipOuterExpressions(filter);
  if (ts.isObjectLiteralExpression(value)) return checkFilterObject(value, context, reason);
  reportWhole(value, context, reason);
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
  if (!filters.length || !isMongoReceiver(call, context)) return;
  for (const filter of filters) checkFilter(filter, context);
}

module.exports = { check, ruleId };
