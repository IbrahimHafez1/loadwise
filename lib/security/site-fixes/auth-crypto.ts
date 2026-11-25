// Rule id -> build({ finding, node, sourceFile, text, load }) => { edits, note } | undefined; see
// lib/performance/site-fix.cjs.
import { calleeName } from '../../performance/call-syntax.js';
import { ts, addProperty, ancestor, calleeCall, replaceNode } from '../../performance/site-fixes/helpers.js';
import { nameText } from '../exposure/literals.js';
import type { CallExpression, Node, PropertyAssignment, SourceFile } from 'typescript';
import type { FixResult, SiteFixBuilder, SiteFixInput, TextEdit } from '../../shared/types.js';

const suggestedBcryptCost = 12;
const defaultSigningAlgorithm = 'HS256';
const secureRandomImport = "import { randomInt } from 'node:crypto';";

function tlsVerificationFix({ finding, node }: SiteFixInput): FixResult | undefined {
  if (!node || finding.contextualReason) return;
  const property = ancestor(node, ts.isPropertyAssignment);
  if (!property || !ts.isObjectLiteralExpression(property.parent) || property.getStart() !== node.getStart()) return;
  const name = nameText(property.name);
  if (name === undefined || !['rejectUnauthorized', 'verifyIdentity', 'strictSSL'].includes(name)) return;
  const options = property.parent.properties;
  if (
    options.some((option) => ts.isSpreadAssignment(option) || (!!option.name && ts.isComputedPropertyName(option.name)))
  )
    return;
  if (options.filter((option) => !!option.name && nameText(option.name) === name).length !== 1) return;
  if (property.initializer.kind !== ts.SyntaxKind.FalseKeyword) return;
  // Review only, never part of `--fix --yes`: with a self-signed or hostname-mismatched certificate
  // this stops working the day TLS is switched on.
  const note =
    'Enables this TLS verification option. Do not apply until the CA certificate (`ca`) is configured for this connection: a self-signed or hostname-mismatched certificate is rejected once verification is on. Verify the server hostname, driver hostname checks and trust chain in your deployment, and update any comment that says verification is skipped.';
  const edits = [replaceNode(property.initializer, 'true')];
  const comment = sameLineComment(property);
  if (!comment) return { edits, requiresReview: true, note };
  return {
    edits: [...edits, comment],
    requiresReview: true,
    note: note + ' Removes the comment beside it, which described the disabled value.',
  };
}

// The comment after `option: false,` on the same line explains the old value and would contradict
// the new one.
function sameLineComment(property: PropertyAssignment): TextEdit | undefined {
  const text = property.getSourceFile().text;
  const comma = /^[ \t]*,/.exec(text.slice(property.end));
  const position = property.end + (comma ? comma[0].length : 0);
  const comments = ts.getTrailingCommentRanges(text, position);
  if (!comments?.length) return;
  return { start: position, end: comments[comments.length - 1].end, text: '' };
}

function bcryptCostFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node || !ts.isNumericLiteral(node)) return;
  return {
    edits: [{ start: node.getStart(), end: node.end, text: String(suggestedBcryptCost) }],
    note: `${suggestedBcryptCost} is a common choice; measure the hashing time on your hardware and adjust.`,
  };
}

// Only static key paths carry enough local evidence for a suggestion. The issuer policy still needs
// review.
function keyReference(node: Node): string | undefined {
  const expression = ts.skipOuterExpressions(node);
  if (ts.isIdentifier(expression)) return expression.text;
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (!ts.isPropertyAccessExpression(expression) || expression.questionDotToken) return;
  const root = keyReference(expression.expression);
  return root && root + '.' + expression.name.text;
}

function signerFor(verify: CallExpression, sourceFile: SourceFile) {
  const callee = ts.skipOuterExpressions(verify.expression);
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression))
    return callee.expression.text + '.sign';
  if (!ts.isIdentifier(callee)) return;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== 'jsonwebtoken') continue;
    const names = statement.importClause?.namedBindings;
    if (!names || !ts.isNamedImports(names)) continue;
    const signer = names.elements.find((item) => (item.propertyName ?? item.name).text === 'sign');
    if (signer) return signer.name.text;
  }
}

function algorithmInSignOptions(call: CallExpression) {
  const argument = call.arguments[2];
  if (!argument) return defaultSigningAlgorithm;
  const options = ts.skipOuterExpressions(argument);
  if (ts.isArrowFunction(options) || ts.isFunctionExpression(options)) return defaultSigningAlgorithm;
  if (!ts.isObjectLiteralExpression(options)) return;
  let algorithm = defaultSigningAlgorithm;
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) return;
    if (property.name.text === 'header') return;
    if (property.name.text !== 'algorithm') continue;
    const value = ts.skipOuterExpressions(property.initializer);
    if (!ts.isStringLiteralLike(value) || !/^(?:HS|RS|PS|ES)(?:256|384|512)$/.test(value.text)) return;
    algorithm = value.text;
  }
  return algorithm;
}

function signingAlgorithm(sourceFile: SourceFile, verify: CallExpression) {
  const key = keyReference(verify.arguments[1]);
  const signer = signerFor(verify, sourceFile);
  if (!key || !signer) return;
  const algorithms = new Set<string | undefined>();
  function visit(node: Node): void {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length >= 2 &&
      keyReference(node.expression) === signer &&
      keyReference(node.arguments[1]) === key
    )
      algorithms.add(algorithmInSignOptions(node));
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return algorithms.size === 1 ? [...algorithms][0] : undefined;
}

function jwtVerifyFix({ node, sourceFile, text }: SiteFixInput): FixResult | undefined {
  const call = node && calleeCall(node);
  if (!call || !sourceFile || text === undefined) return;
  if (calleeName(call) !== 'verify' || call.arguments.length < 2) return;
  const algorithm = signingAlgorithm(sourceFile, call);
  if (!algorithm) return;
  const property = `algorithms: ['${algorithm}']`;
  const options = call.arguments[2] && ts.skipOuterExpressions(call.arguments[2]);
  const note = `Local sign calls using this key expression suggest ${algorithm}. Verify the issuer policy, rotated keys and algorithms of existing tokens before applying.`;
  if (!options || ts.isArrowFunction(options) || ts.isFunctionExpression(options)) {
    const end = call.arguments[1].end;
    return { edits: [{ start: end, end, text: `, { ${property} }` }], requiresReview: true, note };
  }
  if (!ts.isObjectLiteralExpression(options)) return;
  return { edits: [addProperty(options, property, text)], requiresReview: true, note };
}

// The largest range `crypto.randomInt` accepts.
const mathRandomIntegerBound = 2 ** 48 - 1;

// `Math.floor(Math.random() * 100)` -> the `Math.floor` call and its integer bound.
function floorOfScaledRandom(randomCall: CallExpression): { floor: CallExpression; bound: number } | undefined {
  let scaled: Node = randomCall;
  while (scaled.parent && ts.isParenthesizedExpression(scaled.parent)) scaled = scaled.parent;
  const product = scaled.parent;
  if (!product || !ts.isBinaryExpression(product) || product.operatorToken.kind !== ts.SyntaxKind.AsteriskToken) return;
  if (product.left !== scaled || !ts.isNumericLiteral(product.right)) return;
  const bound = Number(product.right.text);
  if (!Number.isInteger(bound) || bound < 1 || bound > mathRandomIntegerBound) return;
  let argument: Node = product;
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

function randomIntImportEdit(sourceFile: SourceFile, text: string): TextEdit | undefined {
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  if (!imports.length || /\brandomInt\b/.test(text)) return;
  const hasNodeImport = imports.some((decl) => {
    const spec = decl.moduleSpecifier && ts.isStringLiteral(decl.moduleSpecifier) ? decl.moduleSpecifier.text : '';
    return spec.startsWith('node:') || spec === 'crypto';
  });
  if (!hasNodeImport) return;
  const [last] = imports.slice(-1);
  return { start: last.end, end: last.end, text: `\n${secureRandomImport}` };
}

function insecureRandomFix({ node, sourceFile, text }: SiteFixInput): FixResult | undefined {
  const randomCall = node && ancestor(node, ts.isCallExpression);
  const shape = randomCall && floorOfScaledRandom(randomCall);
  if (!shape || !sourceFile || text === undefined) return;
  const importEdit = randomIntImportEdit(sourceFile, text);
  if (!importEdit) return;
  return {
    edits: [{ start: shape.floor.getStart(), end: shape.floor.end, text: `randomInt(${shape.bound})` }, importEdit],
    note: '`randomInt` draws from the operating system random generator and returns the same range, 0 up to the bound.',
  };
}

const builders: Record<string, SiteFixBuilder> = {
  'tls-verification-disabled': tlsVerificationFix,
  'bcrypt-low-cost': bcryptCostFix,
  'insecure-random-for-secret': insecureRandomFix,
  'jwt-verify-without-algorithms': jwtVerifyFix,
};

export default builders;
