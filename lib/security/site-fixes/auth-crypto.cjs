'use strict';

// Rule id -> build({ finding, node, sourceFile, text, load }) => { edits, note } | undefined; see lib/performance/site-fix.cjs.
const { ts, ancestor, calleeCall, indentationAt } = require('../../performance/site-fixes/helpers.cjs');

const suggestedBcryptCost = 12;
const defaultSigningAlgorithm = 'HS256';
const secureRandomImport = "import { randomInt } from 'node:crypto';";

function bcryptCostFix({ node }) {
  if (!node || !ts.isNumericLiteral(node)) return;
  return {
    edits: [{ start: node.getStart(), end: node.end, text: String(suggestedBcryptCost) }],
    note: `${suggestedBcryptCost} is a common choice; measure the hashing time on your hardware and adjust.`,
  };
}

function calleeName(call) {
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
}

// `process.env.JWT_SECRET` and `this.jwtSecret` name the same secret: compare the last segment without separators.
function keyIdentity(keyNode) {
  const text = ts.skipOuterExpressions(keyNode).getText();
  return text
    .split('.')
    .at(-1)
    .replace(/[^A-Za-z0-9]/g, '')
    .toLowerCase();
}

function propertyNamed(literal, name) {
  return literal.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
      property.name.text === name,
  );
}

// The algorithm every `sign` call with the same key uses, or undefined when it is unknown or they disagree.
function signingAlgorithm(sourceFile, keyNode) {
  const algorithms = new Set();
  let unknown = false;
  (function visit(node) {
    if (ts.isCallExpression(node) && calleeName(node) === 'sign' && node.arguments.length >= 2) {
      if (keyIdentity(node.arguments[1]) === keyIdentity(keyNode)) {
        const options = node.arguments[2] && ts.skipOuterExpressions(node.arguments[2]);
        if (!options || ts.isArrowFunction(options) || ts.isFunctionExpression(options))
          algorithms.add(defaultSigningAlgorithm);
        else if (!ts.isObjectLiteralExpression(options)) unknown = true;
        else {
          const algorithm = propertyNamed(options, 'algorithm');
          if (!algorithm) algorithms.add(defaultSigningAlgorithm);
          else if (ts.isStringLiteralLike(algorithm.initializer)) algorithms.add(algorithm.initializer.text);
          else unknown = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  })(sourceFile);
  return !unknown && algorithms.size === 1 ? [...algorithms][0] : undefined;
}

function addProperty(literal, property, text) {
  const [last] = literal.properties.slice(-1);
  if (!last) return { start: literal.getStart(), end: literal.end, text: `{ ${property} }` };
  const commaEnd = literal.properties.hasTrailingComma ? text.indexOf(',', last.end) + 1 : last.end;
  const multiline = text.slice(literal.getStart(), last.getStart()).includes('\n');
  if (multiline) {
    const lineText = `\n${indentationAt(text, last.getStart())}${property}`;
    return {
      start: commaEnd,
      end: commaEnd,
      text: literal.properties.hasTrailingComma ? `${lineText},` : `,${lineText}`,
    };
  }
  return {
    start: commaEnd,
    end: commaEnd,
    text: literal.properties.hasTrailingComma ? ` ${property},` : `, ${property}`,
  };
}

function jwtVerifyFix({ node, sourceFile, text }) {
  const call = node && calleeCall(node);
  if (!call || calleeName(call) !== 'verify' || call.arguments.length < 2) return;
  const algorithm = signingAlgorithm(sourceFile, call.arguments[1]);
  if (!algorithm) return;
  const property = `algorithms: ['${algorithm}']`;
  const options = call.arguments[2] && ts.skipOuterExpressions(call.arguments[2]);
  const note = `Assumes the token is signed with ${algorithm}, the algorithm the \`sign\` calls on this key use.`;
  if (!options || ts.isArrowFunction(options) || ts.isFunctionExpression(options)) {
    const end = call.arguments[1].end;
    return { edits: [{ start: end, end, text: `, { ${property} }` }], note };
  }
  if (!ts.isObjectLiteralExpression(options)) return;
  return { edits: [addProperty(options, property, text)], note };
}

const mathRandomIntegerBound = 2 ** 48;

// `Math.floor(Math.random() * 100)` -> the `Math.floor` call and its integer bound.
function floorOfScaledRandom(randomCall) {
  let scaled = randomCall;
  while (scaled.parent && ts.isParenthesizedExpression(scaled.parent)) scaled = scaled.parent;
  const product = scaled.parent;
  if (!product || !ts.isBinaryExpression(product) || product.operatorToken.kind !== ts.SyntaxKind.AsteriskToken) return;
  if (product.left !== scaled || !ts.isNumericLiteral(product.right)) return;
  const bound = Number(product.right.text);
  if (!Number.isInteger(bound) || bound < 1 || bound > mathRandomIntegerBound) return;
  let argument = product;
  while (argument.parent && ts.isParenthesizedExpression(argument.parent)) argument = argument.parent;
  const floor = argument.parent;
  const isFloor =
    floor &&
    ts.isCallExpression(floor) &&
    floor.arguments.length === 1 &&
    floor.arguments[0] === argument &&
    floor.expression.getText() === 'Math.floor';
  return isFloor ? { floor, bound } : undefined;
}

function randomIntImportEdit(sourceFile, text) {
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  if (!imports.length || /\brandomInt\b/.test(text)) return;
  const [last] = imports.slice(-1);
  return { start: last.end, end: last.end, text: `\n${secureRandomImport}` };
}

function insecureRandomFix({ node, sourceFile, text }) {
  const randomCall = node && ancestor(node, ts.isCallExpression);
  const shape = randomCall && floorOfScaledRandom(randomCall);
  if (!shape) return;
  const importEdit = randomIntImportEdit(sourceFile, text);
  if (!importEdit) return;
  return {
    edits: [{ start: shape.floor.getStart(), end: shape.floor.end, text: `randomInt(${shape.bound})` }, importEdit],
    note: '`randomInt` draws from the operating system random generator and returns the same range, 0 up to the bound.',
  };
}

module.exports = {
  'bcrypt-low-cost': bcryptCostFix,
  'insecure-random-for-secret': insecureRandomFix,
  'jwt-verify-without-algorithms': jwtVerifyFix,
};
