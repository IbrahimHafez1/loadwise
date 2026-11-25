// Nest `forwardRef` module cycles: finds the module specifiers a cycle reaches only through
// forwardRef.
import ts from 'typescript';
import type {
  ArrayLiteralExpression,
  Decorator,
  Identifier,
  Node,
  ObjectLiteralElementLike,
  ObjectLiteralExpression,
  PropertyAssignment,
  SourceFile,
  StringLiteralLike,
} from 'typescript';
import type { SpecifierResolver } from './types/module-resolver.js';
import { childBuffer, bufferChildren } from './child-buffer.js';

// The import a Nest forwardRef callback names: its first named binding and where it comes from.
interface ForwardRefTarget {
  firstName: Identifier;
  moduleSpecifier: StringLiteralLike;
}

interface NestBindings {
  framework: Map<string, string>;
  targets: Map<string, ForwardRefTarget>;
}

interface ForwardRefRecords {
  allowed: Set<Node>;
  imports: Map<string, StringLiteralLike>;
}

function recordForwardRefImports(
  array: ArrayLiteralExpression,
  forwardRefName: string | undefined,
  targets: ReadonlyMap<string, ForwardRefTarget>,
  { allowed, imports }: ForwardRefRecords,
): void {
  for (const entry of array.elements) {
    if (
      !ts.isCallExpression(entry) ||
      !ts.isIdentifier(entry.expression) ||
      entry.expression.text !== forwardRefName ||
      entry.arguments.length !== 1
    )
      continue;
    const callback = entry.arguments[0];
    if (!ts.isArrowFunction(callback) || callback.parameters.length || !ts.isIdentifier(callback.body)) continue;
    const binding = targets.get(callback.body.text);
    if (binding) {
      allowed.add(binding.firstName);
      allowed.add(callback.body);
      imports.set(callback.body.text, binding.moduleSpecifier);
    }
  }
}

function isImportsArray(
  field: ObjectLiteralElementLike,
): field is PropertyAssignment & { initializer: ArrayLiteralExpression } {
  return (
    ts.isPropertyAssignment(field) &&
    (ts.isIdentifier(field.name) || ts.isStringLiteralLike(field.name)) &&
    field.name.text === 'imports' &&
    ts.isArrayLiteralExpression(field.initializer)
  );
}

function nestModuleOptions(decorator: Decorator, moduleName: string | undefined): ObjectLiteralExpression | undefined {
  const call = decorator.expression;
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== moduleName ||
    call.arguments.length !== 1
  )
    return;
  const [options] = call.arguments;
  if (ts.isObjectLiteralExpression(options)) return options;
}

function nestModuleBindings(source: SourceFile, resolve: SpecifierResolver): NestBindings | undefined {
  const framework = new Map<string, string>(),
    targets = new Map<string, ForwardRefTarget>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (
      !clause ||
      clause.isTypeOnly ||
      clause.name ||
      !clause.namedBindings ||
      !ts.isNamedImports(clause.namedBindings)
    )
      continue;
    const items = clause.namedBindings.elements;
    if (statement.moduleSpecifier.text === '@nestjs/common') {
      if (resolve('@nestjs/common', source.fileName, statement.moduleSpecifier)) return;
      const runtimeImports = items.filter((item) => !item.isTypeOnly);
      for (const item of runtimeImports) framework.set((item.propertyName || item.name).text, item.name.text);
    } else if (items.length === 1 && !items[0].isTypeOnly)
      targets.set(items[0].name.text, { firstName: items[0].name, moduleSpecifier: statement.moduleSpecifier });
  }
  if (!framework.has('Module') || !framework.has('forwardRef')) return;
  return { framework, targets };
}

// A Nest module cycle still loads its modules. Only tag references whose sole use
// is the exact deferred callback registered in a top-level @Module imports array.
export function nestForwardReferences(
  source: SourceFile,
  resolve: SpecifierResolver,
): Set<StringLiteralLike> | undefined {
  if (!source.text.includes('@nestjs/common') || !source.text.includes('forwardRef')) return;
  const bindings = nestModuleBindings(source, resolve);
  if (!bindings) return;
  const { framework, targets } = bindings;
  const allowed = new Set<Node>(),
    imports = new Map<string, StringLiteralLike>();
  for (const declaration of source.statements) {
    if (!ts.isClassDeclaration(declaration)) continue;
    for (const decorator of ts.getDecorators(declaration) || []) {
      const options = nestModuleOptions(decorator, framework.get('Module'));
      if (!options) continue;
      for (const field of options.properties.filter(isImportsArray)) {
        recordForwardRefImports(field.initializer, framework.get('forwardRef'), targets, { allowed, imports });
      }
    }
  }
  if (!imports.size) return;
  // An explicit stack keeps long operator chains off the call stack.
  const pending: Node[] = [source];
  excludeImportsUsedOutsideForwardRefs(pending, imports, allowed);
  return new Set(imports.values());
}

function excludeImportsUsedOutsideForwardRefs(
  pending: Node[],
  imports: Map<string, StringLiteralLike>,
  allowed: ReadonlySet<Node>,
): void {
  for (let node = pending.pop(); node && imports.size; node = pending.pop()) {
    if (ts.isIdentifier(node) && imports.has(node.text) && !allowed.has(node)) imports.delete(node.text);
    for (let index = bufferChildren(node) - 1; index >= 0; index--) pending.push(childBuffer[index]);
  }
}
