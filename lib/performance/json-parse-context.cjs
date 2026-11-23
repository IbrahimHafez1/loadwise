'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { calleeName } = require('./call-syntax.cjs');

// The helpers are injected because they are shared with the rest of stream-errors.cjs, which requires this module.
function createJsonParseContext({
  READ_FILE,
  STRING_CONVERSIONS,
  MAX_ALIAS_DEPTH,
  PATH_BUILDERS,
  localInitializer,
  enclosingFunction,
  isMethodCall,
}) {
  const PROJECT_MANIFEST_FILE = /^package\.json$/;
  const COMMAND_REGISTRATION_METHODS = new Set(['action', 'command']);

  // The `readFile` call whose content reaches `node`, following awaits, string conversions and local aliases.
  function readFileCallOf(node, depth = 0) {
    const value = ts.skipOuterExpressions(node);
    if (ts.isAwaitExpression(value)) return readFileCallOf(value.expression, depth);
    if (ts.isCallExpression(value)) {
      const name = calleeName(value);
      if (READ_FILE.test(name)) return value;
      if (STRING_CONVERSIONS.has(name) && ts.isPropertyAccessExpression(value.expression))
        return readFileCallOf(value.expression.expression, depth);
      return undefined;
    }
    if (ts.isIdentifier(value) && depth < MAX_ALIAS_DEPTH) {
      const initializer = localInitializer(value);
      return initializer && readFileCallOf(initializer, depth + 1);
    }
  }

  // The file name an expression ends in when its last path part is a literal, such as `path.join(dir, "package.json")`.
  function literalFileName(node, depth = 0) {
    const value = ts.skipOuterExpressions(node);
    if (ts.isStringLiteralLike(value)) return value.text.split(/[/\\]/).pop();
    if (ts.isCallExpression(value) && PATH_BUILDERS.has(calleeName(value)) && value.arguments.length > 0)
      return literalFileName(value.arguments[value.arguments.length - 1], depth);
    if (ts.isIdentifier(value) && depth < MAX_ALIAS_DEPTH) {
      const initializer = localInitializer(value);
      return initializer && literalFileName(initializer, depth + 1);
    }
  }

  function anchorsAtBundledFolder(node, depth = 0) {
    const value = ts.skipOuterExpressions(node);
    if (ts.isIdentifier(value)) {
      if (value.text === '__dirname') return true;
      const initializer = depth < MAX_ALIAS_DEPTH ? localInitializer(value) : undefined;
      return !!initializer && anchorsAtBundledFolder(initializer, depth + 1);
    }
    return (
      ts.isCallExpression(value) &&
      PATH_BUILDERS.has(calleeName(value)) &&
      anchorsAtBundledFolder(value.arguments[0], depth)
    );
  }

  function localManifestReason(node) {
    const read = readFileCallOf(node.arguments[0]);
    const target = read?.arguments[0];
    if (!target) return;
    const fileName = literalFileName(target);
    if (fileName && PROJECT_MANIFEST_FILE.test(fileName))
      return "This parse reads the project's own package.json, which is as trustworthy as the code that ships it, so a malformed file is a deployment fault rather than bad input.";
    if (fileName?.endsWith('.json') && anchorsAtBundledFolder(target))
      return 'This parse reads a JSON file bundled next to the code, where only a folder name varies, so a malformed file is a deployment fault rather than bad input.';
  }

  function isCommandCallback(node) {
    const callback = enclosingFunction(node);
    const call = callback?.parent;
    return (
      !!call &&
      ts.isCallExpression(call) &&
      call.arguments.includes(callback) &&
      isMethodCall(call, COMMAND_REGISTRATION_METHODS)
    );
  }

  // A `json()` method mirrors `Response.json()`, which rejects on malformed bodies by contract.
  function isResponseJsonWrapper(node) {
    const owner = enclosingFunction(node);
    return !!owner && ts.isMethodDeclaration(owner) && owner.name?.getText() === 'json';
  }

  return { localManifestReason, isCommandCallback, isResponseJsonWrapper };
}

module.exports = { createJsonParseContext };
