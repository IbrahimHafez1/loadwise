'use strict';

const { ts, ancestor, indentationAt } = require('../../performance/site-fixes/helpers.cjs');
const { timingSafeStringComparison } = require('../auth-crypto/comparison.cjs');

const operandNames = new Set(['leftValue', 'rightValue', 'leftBytes', 'rightBytes']);

function importedBinding(specifier, imports, names, declarations) {
  for (const entry of imports) {
    if (entry.moduleSpecifier.text !== specifier.module) continue;
    const bindings = entry.importClause?.namedBindings;
    if (!(bindings && ts.isNamedImports(bindings))) continue;
    for (const { name, propertyName, isTypeOnly } of bindings.elements) {
      if (isTypeOnly || (propertyName ?? name).text !== specifier.exported || operandNames.has(name.text)) continue;
      if (declarations.get(name.text) === 1) return { name: name.text };
    }
  }
  let name = specifier.preferredName;
  for (let suffix = 2; names.has(name); suffix++) name = specifier.preferredName + suffix;
  return { name, statement: `import { ${specifier.exported} as ${name} } from '${specifier.module}';` };
}

function isValueImport(statement) {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return false;
  const clause = statement.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  const bindings = clause.namedBindings;
  return Boolean(
    clause.name ||
    (bindings && (!ts.isNamedImports(bindings) || bindings.elements.some(({ isTypeOnly }) => !isTypeOnly))),
  );
}

function comparisonBindings(sourceFile) {
  const imports = sourceFile.statements.filter(isValueImport);
  // A value import of a Node host module is evidence that adding a Node crypto import fits this source file.
  if (
    !imports.some(
      ({ moduleSpecifier }) => moduleSpecifier.text.startsWith('node:') || moduleSpecifier.text === 'crypto',
    )
  )
    return;
  const names = new Set();
  const declarations = new Map();
  (function visit(node) {
    if (ts.isIdentifier(node)) {
      names.add(node.text);
      if (ts.isDeclarationName(node)) declarations.set(node.text, (declarations.get(node.text) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  })(sourceFile);
  const buffer = importedBinding(
    { module: 'node:buffer', exported: 'Buffer', preferredName: 'loadwiseComparisonBuffer' },
    imports,
    names,
    declarations,
  );
  const compare = importedBinding(
    { module: 'node:crypto', exported: 'timingSafeEqual', preferredName: 'loadwiseTimingSafeEqual' },
    imports,
    names,
    declarations,
  );
  return { buffer, compare, lastImport: imports.at(-1) };
}

function importEdit(position, comparison, statements, sourceFile, text) {
  const endOfLine = text.indexOf('\n', position);
  const end = endOfLine < 0 ? text.length : endOfLine - Number(text[endOfLine - 1] === '\r');
  // Leave other statements and multiline trailing comments on the import line alone.
  if (!/^\s*(?:\/\/[^\r\n]*)?$/.test(text.slice(position, end))) return;
  const importLine = sourceFile.getLineAndCharacterOfPosition(end).line;
  const comparisonLine = sourceFile.getLineAndCharacterOfPosition(comparison.getStart()).line;
  if (importLine === comparisonLine) return;
  return { start: end, end, text: '\n' + statements.join('\n') };
}

function secretComparisonFix({ finding, node, sourceFile, text }) {
  const proof = finding[timingSafeStringComparison];
  if (!proof || !node) return;
  const comparison = ancestor(node, (candidate) => ts.isBinaryExpression(candidate) && candidate.getText() === proof);
  if (!comparison || /\/[/*]/.test(text.slice(comparison.left.end, comparison.right.getStart()))) return;
  const bindings = comparisonBindings(sourceFile);
  if (!bindings) return;
  const { buffer, compare, lastImport } = bindings;
  const start = comparison.getStart();
  const indentation = indentationAt(text, start);
  const negation = comparison.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ? '!' : '';
  const typedParams = /\.[cm]?tsx?$/i.test(sourceFile.fileName)
    ? '(leftValue: unknown, rightValue: unknown)'
    : '(leftValue, rightValue)';
  const replacement = [
    `${negation}(${typedParams} => {`,
    `${indentation}  if (typeof leftValue !== 'string' || typeof rightValue !== 'string') return leftValue === rightValue;`,
    `${indentation}  const leftBytes = ${buffer.name}.from(leftValue, 'utf16le');`,
    `${indentation}  const rightBytes = ${buffer.name}.from(rightValue, 'utf16le');`,
    `${indentation}  return leftBytes.length === rightBytes.length && ${compare.name}(leftBytes, rightBytes);`,
    `${indentation}})(${comparison.left.getText()}, ${comparison.right.getText()})`,
  ].join('\n');
  const edits = [{ start, end: comparison.end, text: replacement }];
  const imports = [buffer.statement, compare.statement].filter(Boolean);
  if (imports.length) {
    const insertion = importEdit(lastImport.end, comparison, imports, sourceFile, text);
    if (!insertion) return;
    edits.push(insertion);
  }
  return {
    edits,
    separateEdits: true,
    note: 'Compares equal-length UTF-16 buffers while retaining JavaScript string equality and evaluating each operand once.',
  };
}

module.exports = { 'secret-compared-non-constant-time': secretComparisonFix };
