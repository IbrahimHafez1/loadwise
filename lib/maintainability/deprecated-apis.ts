import ts from 'typescript';
import { walkNodes } from './walk.js';
import { generatedSource } from './duplicates.js';
import { isVendoredMinified } from '../shared/execution-context.js';
import type { CallExpression, Node, SourceFile } from 'typescript';
import type { Finding } from '../shared/types.js';

// A Node module member that is deprecated, and what to use instead.
interface DeprecatedMember {
  modules: readonly string[];
  member: string;
  message: string;
}

// Where one module is bound in a file: names for the whole module, and names for the member itself.
interface ModuleBindings {
  namespaces: Set<string>;
  members: Set<string>;
}

const bufferName = 'Buffer';
const bufferModules: readonly string[] = ['buffer', 'node:buffer'];

const deprecatedMembers: readonly DeprecatedMember[] = [
  {
    modules: ['url', 'node:url'],
    member: 'parse',
    message:
      '`url.parse()` is deprecated and mis-parses some hostnames, which has led to spoofing bugs. Use `new URL(input, base)` and read `hostname`, `pathname` and `searchParams` from it.',
  },
  {
    modules: ['fs', 'node:fs'],
    member: 'exists',
    message:
      '`fs.exists()` is deprecated because its callback has no error argument. Use `fs.existsSync(path)`, or `fs.promises.access(path)` when the check must not block.',
  },
];

const bufferMessage =
  '`new Buffer()` is deprecated (DEP0005) and can expose uninitialized memory depending on its argument. Use `Buffer.alloc(size)` for a zero-filled buffer or `Buffer.from(value)` to copy existing data.';

// A file naming none of the deprecated APIs cannot hold a finding, so it is never walked.
function mentionsWatchedName(text: string): boolean {
  return text.includes(bufferName) || deprecatedMembers.some(({ member }) => text.includes(member));
}

function stringArgument(call: CallExpression): string | undefined {
  const [argument] = call.arguments;
  return call.arguments.length === 1 && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

function requiredModule(node: Node | undefined): string | undefined {
  if (!node || !ts.isCallExpression(node)) return;
  return ts.isIdentifier(node.expression) && node.expression.text === 'require' ? stringArgument(node) : undefined;
}

function importedBindings(declaration: ts.ImportDeclaration, member: string, bindings: ModuleBindings): void {
  const clause = declaration.importClause;
  if (!clause) return;
  if (clause.name) bindings.namespaces.add(clause.name.text);
  const named = clause.namedBindings;
  if (named && ts.isNamespaceImport(named)) bindings.namespaces.add(named.name.text);
  if (!named || !ts.isNamedImports(named)) return;
  for (const element of named.elements) {
    if ((element.propertyName ?? element.name).text === member) bindings.members.add(element.name.text);
  }
}

function requiredBindings(name: ts.BindingName, member: string, bindings: ModuleBindings): void {
  if (ts.isIdentifier(name)) bindings.namespaces.add(name.text);
  if (!ts.isObjectBindingPattern(name)) return;
  for (const element of name.elements) {
    const source = element.propertyName ?? element.name;
    if (ts.isIdentifier(element.name) && ts.isIdentifier(source) && source.text === member)
      bindings.members.add(element.name.text);
  }
}

interface MemberBindings {
  deprecated: DeprecatedMember;
  bindings: ModuleBindings;
}

// What one pass learns: where each deprecated module is bound, and how often each name is declared.
interface FileBindings {
  memberBindings: MemberBindings[];
  declarationCounts: Map<string, number>;
}

function collectFileBindings(sourceFile: SourceFile): FileBindings {
  const memberBindings = deprecatedMembers.map((deprecated) => ({
    deprecated,
    bindings: { namespaces: new Set<string>(), members: new Set<string>() },
  }));
  const declarationCounts = new Map<string, number>();
  walkNodes(sourceFile, (node: Node) => {
    const declared = declaredIdentifier(node);
    if (declared) declarationCounts.set(declared.text, (declarationCounts.get(declared.text) ?? 0) + 1);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      for (const { deprecated, bindings } of memberBindings) {
        if (deprecated.modules.includes(node.moduleSpecifier.text)) importedBindings(node, deprecated.member, bindings);
      }
    } else if (ts.isVariableDeclaration(node)) {
      const moduleName = requiredModule(node.initializer);
      if (moduleName === undefined) return;
      for (const { deprecated, bindings } of memberBindings) {
        if (deprecated.modules.includes(moduleName)) requiredBindings(node.name, deprecated.member, bindings);
      }
    }
  });
  return { memberBindings, declarationCounts };
}

// Without a type checker a callee cannot be traced to its binding, so a name declared a second time
// anywhere (a parameter or local that shadows the import) is not trusted to mean the import.
function withoutRedeclaredNames({ memberBindings, declarationCounts }: FileBindings): MemberBindings[] {
  const declaredOnce = (name: string): boolean => declarationCounts.get(name) === 1;
  return memberBindings.map(({ deprecated, bindings }) => ({
    deprecated,
    bindings: {
      namespaces: new Set([...bindings.namespaces].filter(declaredOnce)),
      members: new Set([...bindings.members].filter(declaredOnce)),
    },
  }));
}

function callsMember(call: CallExpression, deprecated: DeprecatedMember, bindings: ModuleBindings): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return bindings.members.has(callee.text);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== deprecated.member) return false;
  if (ts.isIdentifier(callee.expression)) return bindings.namespaces.has(callee.expression.text);
  const moduleName = requiredModule(callee.expression);
  return moduleName !== undefined && deprecated.modules.includes(moduleName);
}

function declaredIdentifier(node: Node): ts.Identifier | undefined {
  const named =
    ts.isImportSpecifier(node) ||
    ts.isImportClause(node) ||
    ts.isNamespaceImport(node) ||
    ts.isImportEqualsDeclaration(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isBindingElement(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node);
  return named && node.name && ts.isIdentifier(node.name) ? node.name : undefined;
}

// Whether a file declares `name` itself, so a use of it is not the global. Importing `Buffer` or
// `URL` from the Node module that defines it still names the same class.
function declaresName(sourceFile: SourceFile, name: string, definingModules: readonly string[]): boolean {
  let declared = false;
  walkNodes(sourceFile, (node: Node) => {
    if (declared) return;
    if (declaredIdentifier(node)?.text !== name) return;
    const importDeclaration = ts.findAncestor(node, ts.isImportDeclaration);
    const fromDefiningModule =
      importDeclaration !== undefined &&
      ts.isStringLiteral(importDeclaration.moduleSpecifier) &&
      definingModules.includes(importDeclaration.moduleSpecifier.text);
    if (!fromDefiningModule) declared = true;
  });
  return declared;
}

function isBufferConstruction(node: Node): node is ts.NewExpression | CallExpression {
  return (
    (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === bufferName
  );
}

function findingAt(sourceFile: SourceFile, file: string, node: Node, message: string): Finding {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file, line: position.line + 1, column: position.character + 1, ruleId: 'deprecated-node-api', message };
}

function checkDeprecatedApis(sourceFile: SourceFile, file: string): Finding[] {
  if (sourceFile.isDeclarationFile || generatedSource(sourceFile, file) || isVendoredMinified(file)) return [];
  if (!mentionsWatchedName(sourceFile.text)) return [];
  const bufferShadowed = sourceFile.text.includes(bufferName) && declaresName(sourceFile, bufferName, bufferModules);
  const memberBindings = withoutRedeclaredNames(collectFileBindings(sourceFile));
  const findings: Finding[] = [];
  walkNodes(sourceFile, (node: Node) => {
    if (!bufferShadowed && isBufferConstruction(node)) findings.push(findingAt(sourceFile, file, node, bufferMessage));
    if (!ts.isCallExpression(node)) return;
    for (const { deprecated, bindings } of memberBindings) {
      if (callsMember(node, deprecated, bindings)) findings.push(findingAt(sourceFile, file, node, deprecated.message));
    }
  });
  return findings;
}

export { checkDeprecatedApis, declaresName, isBufferConstruction };
