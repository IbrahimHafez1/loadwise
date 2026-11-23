'use strict';

// Runtime validation that narrows request data: class-validator DTOs behind NestJS's ValidationPipe, and zod, joi,
// yup and valibot schemas. Everything is read from project syntax and import bindings, never from package types,
// so a project without node_modules gets the same sanitizers.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { importedFrom } = require('../bindings.cjs');
const { isClosedAnchoredRegex } = require('../pg-identifier-guards.cjs');

// Nest parameter decorators whose value ValidationPipe validates against the parameter's class.
const validatedDecorators = new Set(['Body', 'Query', 'Param', 'Args', 'MessageBody']);
// class-validator decorators that leave only digits, hex, a UUID, a boolean, a date or a listed value.
const closedValidators = new Set([
  'IsInt',
  'IsNumber',
  'IsNumberString',
  'IsPositive',
  'IsNegative',
  'IsDivisibleBy',
  'IsUUID',
  'IsEnum',
  'IsIn',
  'IsBoolean',
  'IsBooleanString',
  'IsDate',
  'IsMongoId',
  'IsHexadecimal',
]);
// Letters and digits only: no syntax for any sink, but a word such as `constructor` can still be a property key.
const wordValidators = new Set(['IsAlpha', 'IsAlphanumeric']);
// An e-mail address has no markup or path characters but may hold quotes, so it only protects these sinks.
const emailSafeSinks = new Set(['html', 'proto-key', 'nosql']);
const maxSchemaDepth = 12;

// The declaration an identifier refers to, through imports of project files.
function localDeclaration(identifier, checker) {
  let symbol = checker.getSymbolAtLocation(identifier);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

function decoratorCall(decorator) {
  const expression = decorator.expression;
  return ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) ? expression : undefined;
}

function mentionsValidationPipe(node) {
  return node.getText().includes('ValidationPipe');
}

// `app.useGlobalPipes(new ValidationPipe())` or `{ provide: APP_PIPE, useClass: ValidationPipe }` anywhere in the
// project's own files.
function hasGlobalValidationPipe(program) {
  return (program.getSourceFiles?.() ?? program.getToolingSourceFiles?.() ?? []).some((sourceFile) => {
    if (sourceFile.isDeclarationFile || program.isSourceFileFromExternalLibrary?.(sourceFile)) return false;
    if (!sourceFile.text.includes('ValidationPipe')) return false;
    return !!(function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'useGlobalPipes' &&
        node.arguments.some(mentionsValidationPipe)
      )
        return true;
      if (
        ts.isObjectLiteralExpression(node) &&
        node.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText() === 'provide' &&
            property.initializer.getText() === 'APP_PIPE',
        ) &&
        mentionsValidationPipe(node)
      )
        return true;
      return ts.forEachChild(node, visit);
    })(sourceFile);
  });
}

const globalPipes = new WeakMap();

function usesPipesWithValidation(declaration) {
  return (ts.getDecorators(declaration) ?? []).some((decorator) => {
    const call = decoratorCall(decorator);
    return call?.expression.text === 'UsePipes' && call.arguments.some(mentionsValidationPipe);
  });
}

// ValidationPipe runs for this parameter: globally, on its controller or method, or in its own decorator.
function validationPipeEnabled(parameter, decorator, program) {
  if (decorator.arguments.some(mentionsValidationPipe)) return true;
  const method = parameter.parent;
  if (usesPipesWithValidation(method) || (method.parent && usesPipesWithValidation(method.parent))) return true;
  if (!globalPipes.has(program)) globalPipes.set(program, hasGlobalValidationPipe(program));
  return globalPipes.get(program);
}

function validatedDecorator(parameter, checker) {
  for (const decorator of ts.getDecorators(parameter) ?? []) {
    const call = decoratorCall(decorator);
    const binding = call && importedFrom(call.expression, checker);
    if (binding?.module.startsWith('@nestjs/') && validatedDecorators.has(binding.exported)) return call;
  }
}

function classOf(node, checker) {
  const declaration = node && ts.isIdentifier(node) ? localDeclaration(node, checker) : undefined;
  return declaration && ts.isClassLike(declaration) ? declaration : undefined;
}

// The property declaration, searching base classes and Nest mapped types such as `PartialType(CreateDto)`.
function findProperty(classDeclaration, name, checker, depth = 0) {
  if (!classDeclaration || depth > maxSchemaDepth) return;
  const own = classDeclaration.members.find(
    (member) => ts.isPropertyDeclaration(member) && member.name.getText() === name,
  );
  if (own) return own;
  for (const clause of classDeclaration.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    const base = clause.types[0]?.expression;
    const target = base && ts.isCallExpression(base) ? base.arguments[0] : base;
    const found = findProperty(classOf(target, checker), name, checker, depth + 1);
    if (found) return found;
  }
}

// What one class-validator decorator makes safe: 'all', 'words', 'email', or undefined for nothing.
function validatorStrength(call, checker) {
  const binding = importedFrom(call.expression, checker);
  if (binding?.module !== 'class-validator') return;
  const name = binding.exported;
  if (closedValidators.has(name)) return 'all';
  if (wordValidators.has(name)) return 'words';
  if (name === 'Matches')
    return call.arguments[0] && isClosedAnchoredRegex(call.arguments[0], checker) ? 'words' : undefined;
  if (name === 'IsEmail') return 'email';
  if (name === 'ValidateIf') return 'conditional';
}

function strengthAllows(strength, sinkKind) {
  if (strength === 'all') return true;
  if (strength === 'words') return sinkKind !== 'proto-key';
  return strength === 'email' && emailSafeSinks.has(sinkKind);
}

// `dto.field` of a Nest `@Body() dto: SomeDto` parameter is safe for `sinkKind`: ValidationPipe is enabled and the
// field carries a validator that rules out injected text for that sink. `@ValidateIf` can skip validation.
function validatedField(parameter, name, sinkKind, program, checker) {
  const decorator = validatedDecorator(parameter, checker);
  const type = parameter.type;
  if (!decorator || !type || !ts.isTypeReferenceNode(type)) return false;
  const property = findProperty(classOf(type.typeName, checker), name, checker);
  if (!property) return false;
  const strengths = (ts.getDecorators(property) ?? [])
    .map(decoratorCall)
    .filter(Boolean)
    .map((call) => validatorStrength(call, checker));
  if (strengths.includes('conditional')) return false;
  if (!strengths.some((strength) => strengthAllows(strength, sinkKind))) return false;
  return validationPipeEnabled(parameter, decorator, program);
}

// Schema libraries ---------------------------------------------------------------------------------------------

const schemaModules = new Set(['zod', 'joi', 'yup', 'valibot']);
// Constructors whose result can still hold any client text.
const openBases = new Set(['string', 'any', 'unknown', 'mixed', 'record', 'map', 'alternatives']);
// Constructors whose result is a number, boolean, date or one of a fixed set of values.
const closedBases = new Set([
  'number',
  'bigint',
  'boolean',
  'bool',
  'date',
  'enum',
  'enum_',
  'nativeEnum',
  'literal',
  'picklist',
  'uuid',
]);
// String refinements that leave a closed alphabet.
const closedRefinements = new Set([
  'uuid',
  'guid',
  'cuid',
  'cuid2',
  'ulid',
  'int',
  'integer',
  'alphanum',
  'hex',
  'nanoid',
  'valid',
  'oneOf',
  'equals',
]);
const patternRefinements = new Set(['regex', 'matches', 'pattern']);
// Modifiers that keep the schema's output alphabet.
const neutralModifiers = new Set([
  'min',
  'max',
  'length',
  'nonempty',
  'trim',
  'toLowerCase',
  'toUpperCase',
  'lowercase',
  'uppercase',
  'optional',
  'nullable',
  'nullish',
  'default',
  'describe',
  'email',
  'url',
  'startsWith',
  'endsWith',
  'includes',
  'required',
  'notRequired',
  'defined',
  'strict',
  'label',
  'meta',
  'openapi',
  'refine',
  'superRefine',
  'catch',
  'brand',
  'readonly',
  'passthrough',
  'strip',
  'partial',
  'deepPartial',
  'pick',
  'omit',
  'allow',
  'empty',
  'messages',
  'message',
  'unknown',
  'options',
  'prefs',
  'noUnknown',
  'array',
]);

function schemaLibrary(identifier, checker) {
  const binding = importedFrom(identifier, checker);
  if (!binding) return;
  const name = binding.module.split('/')[0];
  return schemaModules.has(name) ? name : undefined;
}

// The schema expression a name refers to: the initializer of a `const`, through imports of project files.
function schemaExpression(node, checker) {
  let current = ts.skipOuterExpressions(node);
  for (let depth = 0; current && ts.isIdentifier(current) && depth < maxSchemaDepth; depth++) {
    if (schemaLibrary(current, checker)) return current;
    const declaration = localDeclaration(current, checker);
    const constant =
      declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const;
    current = constant && declaration.initializer ? ts.skipOuterExpressions(declaration.initializer) : undefined;
  }
  return current;
}

// The library of the chain's root identifier (`z` in `z.string().uuid()`).
function chainLibrary(node, checker) {
  let current = schemaExpression(node, checker);
  for (let depth = 0; current && depth < maxSchemaDepth; depth++) {
    if (ts.isIdentifier(current)) return schemaLibrary(current, checker);
    if (ts.isCallExpression(current)) current = ts.skipOuterExpressions(current.expression);
    else if (ts.isPropertyAccessExpression(current)) current = ts.skipOuterExpressions(current.expression);
    else return;
  }
}

function literalArguments(call) {
  const values =
    call.arguments.length === 1 && ts.isArrayLiteralExpression(call.arguments[0])
      ? call.arguments[0].elements
      : call.arguments;
  return values.length > 0 && values.every((value) => ts.isStringLiteralLike(value) || ts.isNumericLiteral(value));
}

function objectFields(literal, checker) {
  if (!literal) return;
  const value = schemaExpression(literal, checker);
  if (!value || !ts.isObjectLiteralExpression(value)) return;
  const fields = new Map();
  for (const property of value.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return;
    const node = ts.isPropertyAssignment(property) ? property.initializer : property.name;
    fields.set(property.name.getText().replace(/^['"]|['"]$/g, ''), node);
  }
  return fields;
}

function closedRefinement(name, call, checker) {
  if (patternRefinements.has(name)) return call.arguments[0] && isClosedAnchoredRegex(call.arguments[0], checker);
  if (name === 'valid' || name === 'oneOf' || name === 'equals') return literalArguments(call);
  return closedRefinements.has(name);
}

function baseShape(name, call, checker, depth) {
  if (openBases.has(name)) return { kind: 'open' };
  if (closedBases.has(name)) return { kind: 'closed' };
  if (name === 'object' || name === 'strictObject' || name === 'looseObject') {
    const fields = call.arguments.length ? objectFields(call.arguments[0], checker) : new Map();
    return fields && { kind: 'object', fields };
  }
  if (name === 'array') {
    const element = call.arguments[0] && schemaShape(call.arguments[0], checker, depth + 1);
    return element && (element.kind === 'closed' ? element : { kind: 'open' });
  }
  if (name === 'union') {
    const members =
      call.arguments[0] && ts.isArrayLiteralExpression(call.arguments[0]) ? call.arguments[0].elements : [];
    const shapes = members.map((member) => schemaShape(member, checker, depth + 1));
    if (!shapes.length || shapes.some((shape) => !shape)) return;
    return shapes.every((shape) => shape.kind === 'closed') ? { kind: 'closed' } : { kind: 'open' };
  }
  // valibot: `v.pipe(v.string(), v.uuid())`
  if (name === 'pipe') {
    const [first, ...actions] = call.arguments;
    const shape = first && schemaShape(first, checker, depth + 1);
    const closing = actions.some((action) => {
      const actionCall = ts.skipOuterExpressions(action);
      return (
        ts.isCallExpression(actionCall) &&
        ts.isPropertyAccessExpression(actionCall.expression) &&
        closedRefinement(actionCall.expression.name.text, actionCall, checker)
      );
    });
    return closing ? { kind: 'closed' } : shape;
  }
}

// { kind: 'open' }, { kind: 'closed' }, { kind: 'object', fields }, or undefined when the schema is not understood
// (which the caller treats as clean, like any unknown call).
function schemaShape(node, checker, depth = 0) {
  if (depth > maxSchemaDepth) return;
  const expression = schemaExpression(node, checker);
  if (!expression || !ts.isCallExpression(expression)) return;
  const callee = ts.skipOuterExpressions(expression.expression);
  if (!ts.isPropertyAccessExpression(callee)) return;
  const name = callee.name.text;
  const receiver = ts.skipOuterExpressions(callee.expression);
  // `z.string()`, `Joi.number()`, `z.coerce.number()`
  const root =
    ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'coerce' ? receiver.expression : receiver;
  if (ts.isIdentifier(root) && schemaLibrary(root, checker)) return baseShape(name, expression, checker, depth);
  const shape = schemaShape(receiver, checker, depth + 1);
  if (!shape || shape.kind === 'closed') return shape;
  if (closedRefinement(name, expression, checker)) return { kind: 'closed' };
  if (shape.kind === 'object' && (name === 'extend' || name === 'keys' || name === 'shape')) {
    const added = objectFields(expression.arguments[0], checker);
    return added && { kind: 'object', fields: new Map([...shape.fields, ...added]) };
  }
  return neutralModifiers.has(name) || patternRefinements.has(name) ? shape : undefined;
}

// `schema.parse(input)` and friends: { input, schema, wrapper } where `wrapper` names the result field that holds
// the parsed value (`safeParse(...).data`, joi's `validate(...).value`, valibot's `safeParse(...).output`).
function schemaCall(call, checker) {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return;
  const method = callee.name.text;
  const receiver = ts.skipOuterExpressions(callee.expression);
  // valibot and joi take the schema as an argument: `v.parse(schema, input)`, `Joi.attempt(input, schema)`.
  if (ts.isIdentifier(receiver)) {
    const library = schemaLibrary(receiver, checker);
    if (library === 'valibot' && ['parse', 'parseAsync'].includes(method))
      return { schema: call.arguments[0], input: call.arguments[1] };
    if (library === 'valibot' && ['safeParse', 'safeParseAsync'].includes(method))
      return { schema: call.arguments[0], input: call.arguments[1], wrapper: 'output' };
    if (library === 'joi' && method === 'attempt') return { schema: call.arguments[1], input: call.arguments[0] };
    if (library) return;
  }
  const library = chainLibrary(receiver, checker);
  if (!library) return;
  const input = call.arguments[0];
  if (['parse', 'parseAsync', 'validateSync', 'validateAsync'].includes(method)) return { schema: receiver, input };
  if (['safeParse', 'safeParseAsync'].includes(method)) return { schema: receiver, input, wrapper: 'data' };
  if (method === 'validate') return { schema: receiver, input, wrapper: library === 'joi' ? 'value' : undefined };
}

module.exports = { validatedField, schemaCall, schemaShape };
