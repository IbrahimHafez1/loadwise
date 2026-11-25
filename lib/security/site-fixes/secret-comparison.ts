import { ts, ancestor, indentationAt } from '../../performance/site-fixes/helpers.js';
import { timingSafeStringComparison } from '../auth-crypto/comparison.js';
import type { BinaryExpression, ImportDeclaration, Node, SourceFile, Statement, StringLiteral } from 'typescript';
import type { FixResult, SiteFixBuilder, SiteFixInput, TextEdit } from '../../shared/types.js';

const operandNames = new Set(['leftValue', 'rightValue', 'leftBytes', 'rightBytes']);

// An import of `exported` from `module` to add, under `preferredName` or the next free name.
interface ImportRequest {
  module: string;
  exported: string;
  preferredName: string;
}

// The local name a request resolves to, and the import statement to add when none exists yet.
interface ImportBinding {
  name: string;
  statement?: string;
}

type ValueImport = ImportDeclaration & { moduleSpecifier: StringLiteral };

function importedBinding(
  specifier: ImportRequest,
  imports: readonly ValueImport[],
  names: ReadonlySet<string>,
  declarations: ReadonlyMap<string, number>,
): ImportBinding {
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

function isValueImport(statement: Statement): statement is ValueImport {
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

function comparisonBindings(sourceFile: SourceFile) {
  const imports = sourceFile.statements.filter(isValueImport);
  // A value import of a Node host module is evidence that adding a Node crypto import fits this
  // source file.
  if (
    !imports.some(
      ({ moduleSpecifier }) => moduleSpecifier.text.startsWith('node:') || moduleSpecifier.text === 'crypto',
    )
  )
    return;
  const names = new Set<string>();
  const declarations = new Map<string, number>();
  (function visit(node: Node): void {
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
  return { buffer, compare, lastImport: imports[imports.length - 1] };
}

function importEdit(
  position: number,
  comparison: BinaryExpression,
  statements: readonly string[],
  sourceFile: SourceFile,
  text: string,
): TextEdit | undefined {
  const endOfLine = text.indexOf('\n', position);
  const end = endOfLine < 0 ? text.length : endOfLine - Number(text[endOfLine - 1] === '\r');
  // Leave other statements and multiline trailing comments on the import line alone.
  if (!/^\s*(?:\/\/[^\r\n]*)?$/.test(text.slice(position, end))) return;
  const importLine = sourceFile.getLineAndCharacterOfPosition(end).line;
  const comparisonLine = sourceFile.getLineAndCharacterOfPosition(comparison.getStart()).line;
  if (importLine === comparisonLine) return;
  return { start: end, end, text: '\n' + statements.join('\n') };
}

function secretComparisonFix({ finding, node, sourceFile, text }: SiteFixInput): FixResult | undefined {
  const proof = timingSafeStringComparison in finding ? finding[timingSafeStringComparison] : undefined;
  if (typeof proof !== 'string' || !proof || !node || !sourceFile || text === undefined) return;
  const comparison = ancestor(
    node,
    (candidate): candidate is BinaryExpression => ts.isBinaryExpression(candidate) && candidate.getText() === proof,
  );
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
  const edits: TextEdit[] = [{ start, end: comparison.end, text: replacement }];
  const imports = [buffer.statement, compare.statement].filter(
    (statement): statement is string => statement !== undefined,
  );
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

const builders: Record<string, SiteFixBuilder> = { 'secret-compared-non-constant-time': secretComparisonFix };

export default builders;
