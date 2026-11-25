// Edits to the imports around a sync call that is rewritten to its promise counterpart: adding the
// new import lines and dropping the sync import once nothing else uses it.
import { ts } from './helpers.js';
import type {
  BindingElement,
  Expression,
  Identifier,
  ImportDeclaration,
  ImportSpecifier,
  Node,
  ObjectBindingPattern,
  SourceFile,
  Statement,
  VariableDeclaration,
  VariableStatement,
  CallExpression,
} from 'typescript';
import type { TextEdit } from '../../shared/types.js';
import type { ModuleBindingStatement } from './types/module-binding.js';

const moduleSpecifierPrefix = /^node:/;

/**
 * The import specifier or require binding element that declares a local name, with its list and
 * statement.
 */
interface BindingDeclaration {
  statement: ImportDeclaration | VariableStatement;
  element: ImportSpecifier | BindingElement;
  elements: readonly (ImportSpecifier | BindingElement)[];
  specifier: Expression;
}

function moduleNameOf(specifier: Node | undefined): string | undefined {
  if (!specifier || !ts.isStringLiteralLike(specifier)) return;
  return specifier.text.replace(moduleSpecifierPrefix, '');
}

function requiredModuleName(initializer: Expression | undefined): string | undefined {
  if (!initializer || !ts.isCallExpression(initializer)) return;
  const { expression, arguments: args } = initializer;
  if (!ts.isIdentifier(expression) || expression.text !== 'require' || args.length !== 1) return;
  return moduleNameOf(args[0]);
}
function moduleSpecifierOf(statement: ModuleBindingStatement): Expression | undefined {
  if (ts.isImportDeclaration(statement)) return statement.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(statement)) {
    return ts.isExternalModuleReference(statement.moduleReference) ? statement.moduleReference.expression : undefined;
  }
  for (const declaration of statement.declarationList.declarations) {
    const initializer = declaration.initializer;
    if (initializer && ts.isCallExpression(initializer) && requiredModuleName(initializer))
      return initializer.arguments[0];
  }
}

function semicolonOf(text: string, statement: Statement, sourceFile: SourceFile) {
  return text.slice(statement.getStart(sourceFile), statement.end).trimEnd().endsWith(';') ? ';' : '';
}

// Inserts `lines` after `statement`, each on its own line with the statement's indentation.
function linesAfter(text: string, statement: Statement, sourceFile: SourceFile, lines: readonly string[]): TextEdit {
  const lineBreak = text.includes('\r\n') ? '\r\n' : '\n';
  const statementStart = statement.getStart(sourceFile);
  const [indentation] = /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', statementStart - 1) + 1)) ?? [''];
  const inserted = lines.map((line) => lineBreak + indentation + line).join('');
  return { start: statement.end, end: statement.end, text: inserted };
}

// One import line per module, written the way `anchor` imports its module (`import` or `require`,
// `node:`, quotes).
function importLinesEdit(
  sourceFile: SourceFile,
  anchor: ModuleBindingStatement,
  namesByModule: ReadonlyMap<string, ReadonlySet<string>>,
): TextEdit | undefined {
  const text = sourceFile.text;
  const specifier = moduleSpecifierOf(anchor);
  if (!specifier || !ts.isStringLiteralLike(specifier)) return;
  const quote = text[specifier.getStart(sourceFile)];
  const prefix = specifier.text.startsWith('node:') ? 'node:' : '';
  const semicolon = semicolonOf(text, anchor, sourceFile);
  const lines = [...namesByModule].map(([moduleName, names]) => {
    const quoted = `${quote}${prefix}${moduleName}${quote}`;
    const list = [...names].join(', ');
    return ts.isVariableStatement(anchor)
      ? `const { ${list} } = require(${quoted})${semicolon}`
      : `import { ${list} } from ${quoted}${semicolon}`;
  });
  return linesAfter(text, anchor, sourceFile, lines);
}

// Whether `name` appears anywhere besides the `skipped` identifiers, not counting member and key
// names.
function usedElsewhere(sourceFile: SourceFile, name: string, skipped: readonly Node[]): boolean {
  let used = false;
  (function visit(node: Node): void {
    if (used) return;
    if (ts.isIdentifier(node) && node.text === name && !skipped.includes(node)) {
      const { parent } = node;
      const isMember = ts.isPropertyAccessExpression(parent) && parent.name === node;
      const isKey =
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        ((ts.isBindingElement(parent) || ts.isImportSpecifier(parent)) && parent.propertyName === node);
      if (!isMember && !isKey) used = true;
    }
    ts.forEachChild(node, visit);
  })(sourceFile);
  return used;
}

/** A destructured `require` that binds a name: the element, its pattern and the require call. */
interface RequiredBinding {
  element: BindingElement;
  pattern: ObjectBindingPattern;
  initializer: CallExpression;
}

// The element of `const { ... } = require(...)` that binds `localName`.
function requiredBinding(declaration: VariableDeclaration, localName: string): RequiredBinding | undefined {
  const initializer = declaration.initializer;
  if (!ts.isObjectBindingPattern(declaration.name) || !initializer || !ts.isCallExpression(initializer)) return;
  if (!requiredModuleName(initializer)) return;
  const pattern = declaration.name;
  const element = pattern.elements.find(
    (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === localName,
  );
  return element && { element, pattern, initializer };
}

function firstRequiredBinding(statement: VariableStatement, localName: string): RequiredBinding | undefined {
  for (const declaration of statement.declarationList.declarations) {
    const required = requiredBinding(declaration, localName);
    if (required) return required;
  }
}

// The import specifier or require binding element that declares `localName`, with its list and
// statement.
function bindingDeclaration(sourceFile: SourceFile, localName: string): BindingDeclaration | undefined {
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      const element = bindings.elements.find((candidate) => candidate.name.text === localName);
      if (element) return { statement, element, elements: bindings.elements, specifier: statement.moduleSpecifier };
    } else if (ts.isVariableStatement(statement)) {
      const required = firstRequiredBinding(statement, localName);
      if (!required) continue;
      if (statement.declarationList.declarations.length !== 1) return;
      return {
        statement,
        element: required.element,
        elements: required.pattern.elements,
        specifier: required.initializer.arguments[0],
      };
    }
  }
}

// Once the call no longer uses the sync import, drop it (or its whole statement) and import the
// promise name from
// `fs/promises` beside it, written the way the file already imports `fs`. Undefined keeps the
// import and the note.
function swappedImportEdits(
  sourceFile: SourceFile,
  calleeName: Identifier,
  promiseName: string,
  needsImport: boolean,
): TextEdit[] | undefined {
  const localName = calleeName.text;
  const found = bindingDeclaration(sourceFile, localName);
  if (!found || usedElsewhere(sourceFile, localName, [calleeName, found.element.name])) return;
  const { statement, element, elements, specifier } = found;
  const text = sourceFile.text;
  if (!ts.isStringLiteralLike(specifier)) return;
  const quote = text[specifier.getStart(sourceFile)];
  const promisesModule = `${quote}${specifier.text}/promises${quote}`;
  const semicolon = semicolonOf(text, statement, sourceFile);
  const added = ts.isImportDeclaration(statement)
    ? `import { ${promiseName} } from ${promisesModule}${semicolon}`
    : `const { ${promiseName} } = require(${promisesModule})${semicolon}`;
  const statementStart = statement.getStart(sourceFile);
  const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
  if (elements.length === 1 && !clause?.name) {
    const replaced = { start: statementStart, end: statement.end, text: needsImport ? added : '' };
    return [needsImport ? replaced : wholeLine(text, replaced)];
  }
  const index = elements.indexOf(element);
  let removal: TextEdit;
  if (elements.length === 1 && clause?.name && clause.namedBindings)
    removal = { start: clause.name.end, end: clause.namedBindings.end, text: '' };
  else if (index < elements.length - 1)
    removal = { start: element.getStart(sourceFile), end: elements[index + 1].getStart(sourceFile), text: '' };
  else removal = { start: elements[index - 1].end, end: element.end, text: '' };
  if (!needsImport) return [removal];
  return [removal, linesAfter(text, statement, sourceFile, [added])];
}

// Widens a statement removal to its whole line when nothing else shares the line.
function wholeLine(text: string, edit: TextEdit) {
  const lineBegin = text.lastIndexOf('\n', edit.start - 1) + 1;
  const nextBreak = text.indexOf('\n', edit.end);
  const lineFinish = nextBreak === -1 ? text.length : nextBreak + 1;
  if (text.slice(lineBegin, edit.start).trim() || text.slice(edit.end, lineFinish).trim()) return edit;
  return { start: lineBegin, end: lineFinish, text: '' };
}

export { importLinesEdit, moduleNameOf, requiredModuleName, swappedImportEdits };
