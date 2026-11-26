import { ts } from './compiler.js';
import { calleeName } from './call-syntax.js';
import type { CallExpression, Expression, Identifier, Node, SignatureDeclaration } from 'typescript';

// The helpers stream-errors.cjs shares with this module.
interface JsonParseHelpers {
  READ_FILE: RegExp;
  STRING_CONVERSIONS: ReadonlySet<string>;
  MAX_ALIAS_DEPTH: number;
  PATH_BUILDERS: ReadonlySet<string>;
  localInitializer(identifier: Identifier): Expression | undefined;
  enclosingFunction(node: Node): SignatureDeclaration | undefined;
  isMethodCall(node: Node, names: ReadonlySet<string>): boolean;
}

interface JsonParseContext {
  localManifestReason(node: CallExpression): string | undefined;
  isCommandCallback(node: Node): boolean;
  isResponseJsonWrapper(node: Node): boolean;
}

// The helpers are injected because they are shared with the rest of stream-errors.cjs, which
// requires this module.
function createJsonParseContext({
  READ_FILE,
  STRING_CONVERSIONS,
  MAX_ALIAS_DEPTH,
  PATH_BUILDERS,
  localInitializer,
  enclosingFunction,
  isMethodCall,
}: JsonParseHelpers): JsonParseContext {
  const PROJECT_MANIFEST_FILE = /^package\.json$/;
  const COMMAND_REGISTRATION_METHODS = new Set(['action', 'command']);

  // The `readFile` call whose content reaches `node`, following awaits, string conversions and
  // local aliases.
  function readFileCallOf(node: Node, depth = 0): CallExpression | undefined {
    const value = ts.skipOuterExpressions(node);
    if (ts.isAwaitExpression(value)) return readFileCallOf(value.expression, depth);
    if (ts.isCallExpression(value)) {
      const name = calleeName(value);
      if (name !== undefined && READ_FILE.test(name)) return value;
      if (name !== undefined && STRING_CONVERSIONS.has(name) && ts.isPropertyAccessExpression(value.expression))
        return readFileCallOf(value.expression.expression, depth);
      return undefined;
    }
    if (ts.isIdentifier(value) && depth < MAX_ALIAS_DEPTH) {
      const initializer = localInitializer(value);
      return initializer && readFileCallOf(initializer, depth + 1);
    }
  }

  // The file name an expression ends in when its last path part is a literal, such as
  // `path.join(dir, "package.json")` or `${dir}/package.json`.
  function literalFileName(node: Node, depth = 0): string | undefined {
    const value = ts.skipOuterExpressions(node);
    if (ts.isStringLiteralLike(value)) return value.text.split(/[/\\]/).pop();
    if (ts.isTemplateExpression(value)) {
      const tail = value.templateSpans.at(-1)?.literal.text ?? '';
      if (/[/\\]/.test(tail)) return tail.split(/[/\\]/).pop();
    }
    const builderName = ts.isCallExpression(value) ? calleeName(value) : undefined;
    if (
      ts.isCallExpression(value) &&
      builderName !== undefined &&
      PATH_BUILDERS.has(builderName) &&
      value.arguments.length > 0
    )
      return literalFileName(value.arguments[value.arguments.length - 1], depth);
    if (ts.isIdentifier(value) && depth < MAX_ALIAS_DEPTH) {
      const initializer = localInitializer(value);
      return initializer && literalFileName(initializer, depth + 1);
    }
  }

  function isImportMetaDirname(node: Node): boolean {
    return (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'dirname' &&
      ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    );
  }

  function anchorsAtBundledFolder(node: Node, depth = 0): boolean {
    const value = ts.skipOuterExpressions(node);
    if (isImportMetaDirname(value)) return true;
    if (ts.isIdentifier(value)) {
      if (value.text === '__dirname') return true;
      const initializer = depth < MAX_ALIAS_DEPTH ? localInitializer(value) : undefined;
      return !!initializer && anchorsAtBundledFolder(initializer, depth + 1);
    }
    if (ts.isTemplateExpression(value) && value.head.text === '' && value.templateSpans.length > 0) {
      return anchorsAtBundledFolder(value.templateSpans[0].expression, depth);
    }
    if (!ts.isCallExpression(value)) return false;
    const name = calleeName(value);
    return name !== undefined && PATH_BUILDERS.has(name) && anchorsAtBundledFolder(value.arguments[0], depth);
  }

  function localManifestReason(node: CallExpression): string | undefined {
    const read = readFileCallOf(node.arguments[0]);
    const target = read?.arguments[0];
    if (!target) return;
    const fileName = literalFileName(target);
    if (fileName && PROJECT_MANIFEST_FILE.test(fileName))
      return "This parse reads the project's own package.json, which is as trustworthy as the code that ships it, so a malformed file is a deployment fault rather than bad input.";
    if (fileName?.endsWith('.json') && anchorsAtBundledFolder(target))
      return 'This parse reads a JSON file bundled next to the code, where only a folder name varies, so a malformed file is a deployment fault rather than bad input.';
  }

  function isCommandCallback(node: Node): boolean {
    const callback = enclosingFunction(node);
    const call = callback?.parent;
    return (
      !!call &&
      ts.isCallExpression(call) &&
      call.arguments.some((argument) => argument === callback) &&
      isMethodCall(call, COMMAND_REGISTRATION_METHODS)
    );
  }

  // A `json()` method mirrors `Response.json()`, which rejects on malformed bodies by contract.
  function isResponseJsonWrapper(node: Node): boolean {
    const owner = enclosingFunction(node);
    return !!owner && ts.isMethodDeclaration(owner) && owner.name?.getText() === 'json';
  }

  return { localManifestReason, isCommandCallback, isResponseJsonWrapper };
}

export type { JsonParseContext, JsonParseHelpers };
export { createJsonParseContext };
