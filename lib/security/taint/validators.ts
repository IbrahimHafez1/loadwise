// Runtime validation that narrows request data: class-validator DTOs behind NestJS's
// ValidationPipe, and zod, joi, yup and valibot schemas. Everything is read from project syntax and
// import bindings, never from package types, so a project without node_modules gets the same
// sanitizers.
import { ts } from '../../performance/compiler.js';
import { importedFrom } from '../bindings.js';
import { isClosedAnchoredRegex } from '../pg-identifier-guards.js';
import type {
  CallExpression,
  ClassLikeDeclaration,
  Decorator,
  Expression,
  Identifier,
  Node,
  ParameterDeclaration,
  PropertyDeclaration,
  SourceFile,
} from 'typescript';
import type { CheckerAdapter, ProgramAdapter, SchemaShape, SinkKind } from '../../shared/types.js';
import type { SchemaCall } from '../types/schema-call.js';

// Nest parameter decorators whose value ValidationPipe validates against the parameter's class.
const validatedDecorators = new Set(['Body', 'Query', 'Param', 'Args', 'MessageBody']);
// class-validator decorators that leave only digits, hex, a UUID, a boolean, a date or a listed
// value.
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
// Letters and digits only: no syntax for any sink, but a word such as `constructor` can still be a
// property key.
const wordValidators = new Set(['IsAlpha', 'IsAlphanumeric']);
// An e-mail address has no markup or path characters but may hold quotes, so it only protects these
// sinks.
const emailSafeSinks = new Set(['html', 'proto-key', 'nosql']);
const maxSchemaDepth = 12;

/** A decorator or schema call written as `name(...)`. */
type IdentifierCall = CallExpression & { expression: Identifier };

/**
 * What one class-validator decorator makes safe; 'conditional' marks `@ValidateIf`, which can skip
 * validation.
 */
type ValidatorStrength = 'all' | 'words' | 'email' | 'conditional';

/**
 * TypeScript's own program knows which source files come from node_modules; the shared adapter does
 * not list it.
 */
interface ExternalLibraryAwareProgram extends ProgramAdapter {
  isSourceFileFromExternalLibrary?(file: SourceFile): boolean;
}

// The declaration an identifier refers to, through imports of project files.
function localDeclaration(identifier: Identifier, checker: CheckerAdapter) {
  let symbol = checker.getSymbolAtLocation(identifier);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

function isIdentifierCall(expression: Expression): expression is IdentifierCall {
  return ts.isCallExpression(expression) && ts.isIdentifier(expression.expression);
}

function decoratorCall(decorator: Decorator): IdentifierCall | undefined {
  const expression = decorator.expression;
  return isIdentifierCall(expression) ? expression : undefined;
}

function mentionsValidationPipe(node: Node) {
  return node.getText().includes('ValidationPipe');
}

// `app.useGlobalPipes(new ValidationPipe())` or `{ provide: APP_PIPE, useClass: ValidationPipe }`
// anywhere in the project's own files.
function hasGlobalValidationPipe(program: ExternalLibraryAwareProgram): boolean {
  return (program.getSourceFiles?.() ?? program.getToolingSourceFiles?.() ?? []).some((sourceFile: SourceFile) => {
    if (sourceFile.isDeclarationFile || program.isSourceFileFromExternalLibrary?.(sourceFile)) return false;
    if (!sourceFile.text.includes('ValidationPipe')) return false;
    return !!(function visit(node: Node): boolean | undefined {
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

const globalPipes = new WeakMap<ProgramAdapter, boolean>();

function usesPipesWithValidation(declaration: Node) {
  if (!ts.canHaveDecorators(declaration)) return false;
  return (ts.getDecorators(declaration) ?? []).some((decorator) => {
    const call = decoratorCall(decorator);
    return call?.expression.text === 'UsePipes' && call.arguments.some(mentionsValidationPipe);
  });
}

// ValidationPipe runs for this parameter: globally, on its controller or method, or in its own
// decorator.
function validationPipeEnabled(
  parameter: ParameterDeclaration,
  decorator: CallExpression,
  program: ProgramAdapter,
): boolean {
  if (decorator.arguments.some(mentionsValidationPipe)) return true;
  const method = parameter.parent;
  if (usesPipesWithValidation(method) || (method.parent && usesPipesWithValidation(method.parent))) return true;
  let enabled = globalPipes.get(program);
  if (enabled === undefined) globalPipes.set(program, (enabled = hasGlobalValidationPipe(program)));
  return enabled;
}

function validatedDecorator(parameter: ParameterDeclaration, checker: CheckerAdapter): IdentifierCall | undefined {
  for (const decorator of ts.getDecorators(parameter) ?? []) {
    const call = decoratorCall(decorator);
    const binding = call && importedFrom(call.expression, checker);
    if (
      binding?.module.startsWith('@nestjs/') &&
      binding.exported !== undefined &&
      validatedDecorators.has(binding.exported)
    )
      return call;
  }
}

function classOf(node: Node | undefined, checker: CheckerAdapter): ClassLikeDeclaration | undefined {
  const declaration = node && ts.isIdentifier(node) ? localDeclaration(node, checker) : undefined;
  return declaration && ts.isClassLike(declaration) ? declaration : undefined;
}

// The property declaration, searching base classes and Nest mapped types such as
// `PartialType(CreateDto)`.
function findProperty(
  classDeclaration: ClassLikeDeclaration | undefined,
  name: string,
  checker: CheckerAdapter,
  depth = 0,
): PropertyDeclaration | undefined {
  if (!classDeclaration || depth > maxSchemaDepth) return;
  const own = classDeclaration.members.find(
    (member): member is PropertyDeclaration => ts.isPropertyDeclaration(member) && member.name.getText() === name,
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
function validatorStrength(call: CallExpression, checker: CheckerAdapter): ValidatorStrength | undefined {
  const binding = importedFrom(call.expression, checker);
  if (binding?.module !== 'class-validator') return;
  const name = binding.exported;
  if (name === undefined) return;
  if (closedValidators.has(name)) return 'all';
  if (wordValidators.has(name)) return 'words';
  if (name === 'Matches')
    return call.arguments[0] && isClosedAnchoredRegex(call.arguments[0], checker) ? 'words' : undefined;
  if (name === 'IsEmail') return 'email';
  if (name === 'ValidateIf') return 'conditional';
}

function strengthAllows(strength: ValidatorStrength | undefined, sinkKind: SinkKind) {
  if (strength === 'all') return true;
  if (strength === 'words') return sinkKind !== 'proto-key';
  return strength === 'email' && emailSafeSinks.has(sinkKind);
}

// `dto.field` of a Nest `@Body() dto: SomeDto` parameter is safe for `sinkKind`: ValidationPipe is
// enabled and the field carries a validator that rules out injected text for that sink.
// `@ValidateIf` can skip validation.
function validatedField(
  parameter: ParameterDeclaration,
  name: string,
  sinkKind: SinkKind,
  program: ProgramAdapter,
  checker: CheckerAdapter,
): boolean {
  const decorator = validatedDecorator(parameter, checker);
  const type = parameter.type;
  if (!decorator || !type || !ts.isTypeReferenceNode(type)) return false;
  const property = findProperty(classOf(type.typeName, checker), name, checker);
  if (!property) return false;
  const strengths = (ts.getDecorators(property) ?? [])
    .map(decoratorCall)
    .filter((call): call is IdentifierCall => !!call)
    .map((call) => validatorStrength(call, checker));
  if (strengths.includes('conditional')) return false;
  if (!strengths.some((strength) => strengthAllows(strength, sinkKind))) return false;
  return validationPipeEnabled(parameter, decorator, program);
}

// Schema libraries
// ---------------------------------------------------------------------------------------------

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

function schemaLibrary(identifier: Identifier, checker: CheckerAdapter): string | undefined {
  const binding = importedFrom(identifier, checker);
  if (!binding) return;
  const name = binding.module.split('/')[0];
  return schemaModules.has(name) ? name : undefined;
}

// The schema expression a name refers to: the initializer of a `const`, through imports of project
// files.
function schemaExpression(node: Node, checker: CheckerAdapter): Node | undefined {
  let current: Node | undefined = ts.skipOuterExpressions(node);
  for (let depth = 0; current && ts.isIdentifier(current) && depth < maxSchemaDepth; depth++) {
    if (schemaLibrary(current, checker)) return current;
    const declaration = localDeclaration(current, checker);
    const initializer =
      declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const
        ? declaration.initializer
        : undefined;
    current = initializer ? ts.skipOuterExpressions(initializer) : undefined;
  }
  return current;
}

// The library of the chain's root identifier (`z` in `z.string().uuid()`).
function chainLibrary(node: Node, checker: CheckerAdapter): string | undefined {
  let current = schemaExpression(node, checker);
  for (let depth = 0; current && depth < maxSchemaDepth; depth++) {
    if (ts.isIdentifier(current)) return schemaLibrary(current, checker);
    if (ts.isCallExpression(current)) current = ts.skipOuterExpressions(current.expression);
    else if (ts.isPropertyAccessExpression(current)) current = ts.skipOuterExpressions(current.expression);
    else return;
  }
}

function literalArguments(call: CallExpression) {
  const values =
    call.arguments.length === 1 && ts.isArrayLiteralExpression(call.arguments[0])
      ? call.arguments[0].elements
      : call.arguments;
  return values.length > 0 && values.every((value) => ts.isStringLiteralLike(value) || ts.isNumericLiteral(value));
}

function objectFields(literal: Node | undefined, checker: CheckerAdapter): Map<string, Expression> | undefined {
  if (!literal) return;
  const value = schemaExpression(literal, checker);
  if (!value || !ts.isObjectLiteralExpression(value)) return;
  const fields = new Map<string, Expression>();
  for (const property of value.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return;
    const node = ts.isPropertyAssignment(property) ? property.initializer : property.name;
    fields.set(property.name.getText().replaceAll(/^['"]|['"]$/g, ''), node);
  }
  return fields;
}

function closedRefinement(name: string, call: CallExpression, checker: CheckerAdapter) {
  if (patternRefinements.has(name)) return call.arguments[0] && isClosedAnchoredRegex(call.arguments[0], checker);
  if (name === 'valid' || name === 'oneOf' || name === 'equals') return literalArguments(call);
  return closedRefinements.has(name);
}

function baseShape(
  name: string,
  call: CallExpression,
  checker: CheckerAdapter,
  depth: number,
): SchemaShape | undefined {
  if (openBases.has(name)) return { kind: 'open' };
  if (closedBases.has(name)) return { kind: 'closed' };
  if (name === 'object' || name === 'strictObject' || name === 'looseObject') {
    const fields = call.arguments.length ? objectFields(call.arguments[0], checker) : new Map<string, Expression>();
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
    return shapes.every((shape) => shape?.kind === 'closed') ? { kind: 'closed' } : { kind: 'open' };
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

// { kind: 'open' }, { kind: 'closed' }, { kind: 'object', fields }, or undefined when the schema is
// not understood (which the caller treats as clean, like any unknown call).
function schemaShape(node: Node, checker: CheckerAdapter, depth = 0): SchemaShape | undefined {
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
    return added && { kind: 'object', fields: new Map<string, Node>([...(shape.fields ?? []), ...added]) };
  }
  return neutralModifiers.has(name) || patternRefinements.has(name) ? shape : undefined;
}

// `schema.parse(input)` and friends: { input, schema, wrapper } where `wrapper` names the result
// field that holds the parsed value (`safeParse(...).data`, joi's `validate(...).value`, valibot's
// `safeParse(...).output`).
function schemaCall(call: CallExpression, checker: CheckerAdapter): SchemaCall | undefined {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return;
  const method = callee.name.text;
  const receiver = ts.skipOuterExpressions(callee.expression);
  // valibot and joi take the schema as an argument: `v.parse(schema, input)`, `Joi.attempt(input,
  // schema)`.
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

export { validatedField, schemaCall, schemaShape };
