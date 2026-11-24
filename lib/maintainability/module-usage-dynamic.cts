// Helpers that read dynamic import specifiers, worker and URL module references, and constant
// paths.
import path from 'node:path';
import ts from 'typescript';
import { introducesBinding, bindingScope } from './architecture.cjs';
import { walkNodes } from './walk.cjs';
import type {
  BindingName,
  CallExpression,
  Expression,
  Identifier,
  NewExpression,
  Node,
  SourceFile,
  StringLiteralLike,
} from 'typescript';

export function bindingNames(name: BindingName): Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)));
}

// `new URL(...)` naming a module file, with the relative literals it holds.
export interface UrlModule {
  urlConstructor: Identifier;
  literals: StringLiteralLike[];
}

// The initializer of the `const` an identifier names in an enclosing block, so `import(mainPath)`
// reads like the path it was built from. A parameter or another variable of the same name in
// between shadows it.
function constInitializer(identifier: Identifier): Expression | undefined {
  const named = (name: BindingName) => bindingNames(name).some((binding) => binding.text === identifier.text);
  for (let scope: Node | undefined = identifier.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters.some((parameter) => named(parameter.name))) return;
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const declaration = statement.declarationList.declarations.find((item) => named(item.name));
      if (!declaration) continue;
      const constant = statement.declarationList.flags & ts.NodeFlags.Const;
      if (!constant || !ts.isIdentifier(declaration.name) || !declaration.initializer) return;
      return ts.skipOuterExpressions(declaration.initializer);
    }
  }
}

export function resolvedPath(argument: Expression): Expression {
  return (ts.isIdentifier(argument) && constInitializer(argument)) || argument;
}

function isTemporaryDirectoryCall(expression: Expression): boolean {
  if (!ts.isCallExpression(expression)) return false;
  const callee = expression.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  return ts.isIdentifier(name) && name.text === 'tmpdir';
}

// `${os.tmpdir()}/x.mjs` and path.join(os.tmpdir(), 'x.mjs') name a file the process wrote outside
// the project.
export function startsInTemporaryDirectory(argument: Expression): boolean {
  if (ts.isTemplateExpression(argument)) {
    const [firstSpan] = argument.templateSpans;
    return !argument.head.text && isTemporaryDirectoryCall(ts.skipOuterExpressions(firstSpan.expression));
  }
  if (!ts.isCallExpression(argument) || !ts.isPropertyAccessExpression(argument.expression)) return false;
  const [base] = argument.arguments;
  return ['join', 'resolve'].includes(argument.expression.name.text) && Boolean(base) && isTemporaryDirectoryCall(base);
}

// The literal text a dynamic specifier starts with: `./locales/${name}` and './locales/' + name
// both give './locales/'.
export function specifierHead(argument: Expression): string {
  if (ts.isTemplateExpression(argument)) return argument.head.text;
  if (ts.isBinaryExpression(argument) && argument.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return ts.isStringLiteralLike(argument.left) ? argument.left.text : '';
  return '';
}

const workerBindingNames = new Set(['URL']);

function isImportMetaUrl(expression: Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === 'url' &&
    ts.isMetaProperty(expression.expression) &&
    expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    expression.expression.name.text === 'meta'
  );
}

// A relative literal, or a const or conditional choosing between relative literals.
function relativeLiterals(expression: Expression, followConstant = true): StringLiteralLike[] | undefined {
  const target = followConstant ? resolvedPath(expression) : expression;
  if (ts.isStringLiteralLike(target)) return /^\.\.?\//.test(target.text) ? [target] : undefined;
  if (!ts.isConditionalExpression(target)) return;
  const whenTrue = relativeLiterals(ts.skipOuterExpressions(target.whenTrue), false);
  const whenFalse = relativeLiterals(ts.skipOuterExpressions(target.whenFalse), false);
  return whenTrue && whenFalse && [...whenTrue, ...whenFalse];
}

// `new URL('./job.mjs', import.meta.url)` names a module file beside this one, whether a Worker,
// tsImport or a loader receives it.
export function urlModule(node: NewExpression): UrlModule | undefined {
  const urlConstructor = ts.skipOuterExpressions(node.expression);
  if (!ts.isIdentifier(urlConstructor) || urlConstructor.text !== 'URL' || node.arguments?.length !== 2) return;
  const [specifier, base] = node.arguments.map((argument, index) => ts.skipOuterExpressions(argument, index));
  const literals = isImportMetaUrl(base) && relativeLiterals(specifier);
  if (literals) return { urlConstructor, literals };
}

const metaUrlLoaders = new Set(['tsImport', 'register']);

// tsx's `tsImport('./x.ts', import.meta.url)` and node:module's `register('./hooks.mjs',
// import.meta.url)` load a module.
export function metaUrlLoad(node: CallExpression): StringLiteralLike | undefined {
  const callee = node.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  if (!ts.isIdentifier(name) || !metaUrlLoaders.has(name.text) || node.arguments.length < 2) return;
  const [specifier, base] = node.arguments.map((argument, index) => ts.skipOuterExpressions(argument, index));
  if (ts.isStringLiteralLike(specifier) && /^\.\.?\//.test(specifier.text) && isImportMetaUrl(base)) return specifier;
}

// The literal segments of `path.join(__dirname, 'a', 'b.js')` or `path.resolve(...)`, a path in the
// current file's folder.
function besideCurrentFile(pathCall: Expression): StringLiteralLike[] | undefined {
  if (!ts.isCallExpression(pathCall) || !ts.isPropertyAccessExpression(pathCall.expression)) return;
  const method = pathCall.expression;
  if (!ts.isIdentifier(method.expression) || !['join', 'resolve'].includes(method.name.text)) return;
  const [base, ...parts] = pathCall.arguments.map(ts.skipOuterExpressions);
  if (!base || !ts.isIdentifier(base) || base.text !== '__dirname' || !parts.length) return;
  if (parts.every(ts.isStringLiteralLike) && !parts.some((part) => path.posix.isAbsolute(part.text))) return parts;
}

// Node's `new Worker(path.join(__dirname, 'job.js'))` names its module relative to the current
// file's folder.
export function nodeWorkerModule(node: NewExpression): { literal: StringLiteralLike; specifier: string } | undefined {
  const constructor = ts.skipOuterExpressions(node.expression);
  if (!ts.isIdentifier(constructor) || constructor.text !== 'Worker') return;
  const firstArgument = node.arguments?.[0];
  const parts = firstArgument && besideCurrentFile(ts.skipOuterExpressions(firstArgument));
  if (!parts) return;
  const relative = path.posix.join(...parts.map((part) => part.text.replaceAll('\\', '/')));
  const literal = parts.at(-1);
  if (!literal) return;
  return { literal, specifier: relative.startsWith('.') ? relative : './' + relative };
}

export function workerBindingScopes(sourceFile: SourceFile): Map<string, Set<Node | undefined>> {
  const scopes = new Map<string, Set<Node | undefined>>();
  walkNodes(sourceFile, (node: Node) => {
    if (!ts.isIdentifier(node) || !workerBindingNames.has(node.text) || !introducesBinding(node)) return;
    const bindings = scopes.get(node.text) ?? new Set<Node | undefined>();
    bindings.add(bindingScope(node));
    scopes.set(node.text, bindings);
  });
  return scopes;
}

export function isShadowed(
  identifier: Identifier,
  scopes: ReadonlyMap<string, ReadonlySet<Node | undefined>>,
): boolean {
  const bindings = scopes.get(identifier.text);
  if (!bindings) return false;
  for (let scope: Node | undefined = identifier.parent; scope; scope = scope.parent)
    if (bindings.has(scope)) return true;
  return false;
}

export function numericConstant(expression: Expression): boolean {
  if (ts.isNumericLiteral(expression)) return true;
  if (ts.isParenthesizedExpression(expression)) return numericConstant(expression.expression);
  return (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.AsteriskToken &&
    numericConstant(expression.left) &&
    numericConstant(expression.right)
  );
}
