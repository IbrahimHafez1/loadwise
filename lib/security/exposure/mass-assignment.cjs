'use strict';

// mass-assignment: the whole request body is written to the database.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { importedFrom } = require('../bindings.cjs');
const { typeFromPackage } = require('../../performance/package-types.cjs');
const { unwrap, objectLiteralOf, findProperty, methodName } = require('./literals.cjs');
const { reportTraced } = require('./report.cjs');

const ruleId = 'mass-assignment';
const message =
  'The whole request body is written to the database, so a caller can set fields you did not intend (role, ownerId, price). Copy the allowed fields explicitly or validate with a schema that strips unknown keys.';
const prismaWriteMethods = new Set(['create', 'update', 'upsert', 'createMany', 'createManyAndReturn', 'updateMany']);
const prismaDataProperties = { upsert: ['create', 'update'] };
// Argument position of the written data per method.
const typeormDataIndex = { save: 0, insert: 0, create: 0, upsert: 0, update: 1, merge: 1 };
const mongooseDataIndex = {
  create: 0,
  set: 0,
  findByIdAndUpdate: 1,
  findOneAndUpdate: 1,
  update: 1,
  updateOne: 1,
  updateMany: 1,
  replaceOne: 1,
};
const sequelizeDataIndex = { create: 0, update: 0, bulkCreate: 0 };
// `update(values, options)` and `bulkCreate(rows, options)` take the allowed columns in `options.fields`.
const sequelizeOptionsIndex = { create: 1, update: 1, bulkCreate: 1 };
const sequelizeModules = new Set(['sequelize', 'sequelize-typescript']);
const dtoInheritanceDepth = 4;
const schemaParsePattern =
  /(?<!JSON)\.(?:parse|safeParse|parseAsync|safeParseAsync|validateSync|validateAsync|attempt)\(/;

function dataAt(call, index) {
  const argument = call.arguments[index];
  return argument ? [argument] : [];
}

// `prisma.user.create({ data })`: the call shape is specific enough to need no types.
function prismaData(call, context) {
  const method = methodName(call);
  if (!prismaWriteMethods.has(method)) return [];
  const receiver = unwrap(unwrap(call.expression).expression);
  if (!ts.isPropertyAccessExpression(receiver)) return [];
  const options = objectLiteralOf(call.arguments[0], context.checker);
  if (!options) return [];
  return (prismaDataProperties[method] ?? ['data']).map((name) => findProperty(options, name)?.value).filter(Boolean);
}

function sequelizeData(call, method) {
  const options = unwrap(call.arguments[sequelizeOptionsIndex[method]]);
  if (options && ts.isObjectLiteralExpression(options) && findProperty(options, 'fields')) return [];
  return dataAt(call, sequelizeDataIndex[method]);
}

function libraryData(call, context) {
  const info = context.libraryCall(call);
  const method = methodName(call);
  if (!info || !method) return [];
  if (info.module === 'typeorm' && Object.hasOwn(typeormDataIndex, method))
    return dataAt(call, typeormDataIndex[method]);
  if (info.module === 'mongoose' && Object.hasOwn(mongooseDataIndex, method))
    return dataAt(call, mongooseDataIndex[method]);
  if (sequelizeModules.has(info.module) && Object.hasOwn(sequelizeDataIndex, method))
    return sequelizeData(call, method);
  return [];
}

function isMongooseDocument(expression, checker) {
  const type = checker.getTypeAtLocation(expression);
  const members = type.isIntersection() ? type.types : [type];
  return members.some((member) => typeFromPackage(member, ['mongoose'], ['Document', 'Model']));
}

// `Object.assign(document, request)` on a Mongoose document.
function assignedData(call, context) {
  const callee = unwrap(call.expression);
  const isAssign =
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'assign' &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'Object';
  if (!isAssign || call.arguments.length < 2 || !isMongooseDocument(call.arguments[0], context.checker)) return [];
  return call.arguments.slice(1);
}

function hasValidationDecorator(declaration, checker) {
  return declaration.members.some((member) =>
    (ts.getDecorators(member) ?? []).some((decorator) => {
      const callee = ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression;
      return ts.isIdentifier(callee) && importedFrom(callee, checker)?.module === 'class-validator';
    }),
  );
}

function classOf(expression, checker) {
  const node = unwrap(expression);
  const symbol = node && ts.isIdentifier(node) ? checker.getSymbolAtLocation(node) : undefined;
  const resolved = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return resolved?.declarations?.find(ts.isClassDeclaration);
}

// `extends PartialType(CreateDto)` inherits the validators of CreateDto.
function baseClassExpression(heritageExpression) {
  const expression = unwrap(heritageExpression);
  return ts.isCallExpression(expression) ? expression.arguments[0] : expression;
}

// A class whose properties carry class-validator decorators, directly or through its base class. A base class that
// cannot be resolved counts as validated, because without it the DTO cannot be judged.
function isValidatedClass(declaration, checker, depth = dtoInheritanceDepth) {
  if (hasValidationDecorator(declaration, checker)) return true;
  const base = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
  if (!base) return false;
  const baseDeclaration = depth > 0 ? classOf(baseClassExpression(base.expression), checker) : undefined;
  return baseDeclaration ? isValidatedClass(baseDeclaration, checker, depth - 1) : true;
}

// A NestJS `@Body() dto: CreateDto` whose class validates its properties; `nest-validation-without-whitelist`
// covers what such a DTO lets through, so it is not reported twice.
function isValidatedDto(traced, checker) {
  const parameter = ts.isParameter(traced.sourceNode) ? traced.sourceNode : undefined;
  const typeNode = parameter?.type;
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return false;
  const name = ts.isIdentifier(typeNode.typeName) ? typeNode.typeName : typeNode.typeName.right;
  const declaration = classOf(name, checker);
  return Boolean(declaration && isValidatedClass(declaration, checker));
}

// tRPC `input` was parsed by the procedure's schema.
function isSchemaInput(traced) {
  return /^(?:opts\.)?input\b|^tRPC$/.test(traced.label);
}

// zod, joi, yup and valibot objects drop unknown keys by default, so a value that went through `schema.parse(...)`
// on its way here holds only the declared fields. The trace step texts are the only record of that call.
function wasParsedBySchema(traced) {
  return traced.steps.some((step) => schemaParsePattern.test(step.text));
}

function checkData(expression, context) {
  const traced = context.taint.trace(expression, 'mass-assignment');
  if (!traced?.whole || isSchemaInput(traced) || wasParsedBySchema(traced)) return;
  if (isValidatedDto(traced, context.checker)) return;
  const reason = traced.hops < 2 ? 'Confirm that request validation or middleware limits writable fields.' : undefined;
  reportTraced(context, expression, ruleId, message, traced, reason);
}

function checkCall(call, context) {
  const written = [...prismaData(call, context), ...libraryData(call, context), ...assignedData(call, context)];
  for (const expression of written) checkData(expression, context);
}

// `new User(request.body)` on a Mongoose model.
function checkNew(node, context) {
  const [argument] = node.arguments ?? [];
  if (argument && context.isPackageType(node.expression, ['mongoose'], ['Model'])) checkData(argument, context);
}

module.exports = { checkCall, checkNew };
