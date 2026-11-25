import type {
  ArrayLiteralExpression,
  ArrowFunction,
  Block,
  Identifier,
  ImportClause,
  MethodDeclaration,
  NamespaceImport,
  Node,
  PropertyAssignment,
  ImportSpecifier,
  SourceFile,
  Statement,
  TypeNode,
  VariableDeclaration,
  VariableStatement,
} from 'typescript';
import type { TextEdit } from '../../shared/types.cjs';
import type { DuplicateSite, StringLiteralImport } from './duplicate-sites.cjs';
import type { LocatedFinding } from './module-graph.cjs';

/** One function body reduced to its comparison key and where it is declared. */
export interface Implementation {
  key: string;
  line: number;
  column: number;
}

/**
 * What one source file contributes to duplicate detection, as plain data that can cross a thread
 * boundary.
 */
export interface ExtractedImplementations {
  implementations: Implementation[];
  documentsReference: boolean;
}

/** Groups identical implementations across files and reports each group once. */
export interface ImplementationIndex {
  addExtracted(relativePath: string, extracted: ExtractedImplementations | undefined): void;
  add(file: SourceFile, relativePath: string): void;
  findings(): LocatedFinding[];
}

/** A copy that is an arrow function, as callbacks and exported arrows are. */
export interface ArrowSite extends DuplicateSite {
  fn: ArrowFunction & { readonly body: Block };
}

/** A copy that is a class method. */
export interface MethodSite extends DuplicateSite {
  fn: MethodDeclaration & { readonly body: Block };
}

/** A name the copy's function declares, with the name's import clause, namespace import or import specifier. */
export type ImportBinding = ImportClause | NamespaceImport | ImportSpecifier;

export interface StrandedImport {
  declaration: StringLiteralImport;
  binding: ImportBinding;
  name: string;
}

/** What replaces a copy's body with a call: the local name to call and the import edit that provides it, if any. */
export interface ImportEdit {
  local: string;
  edit?: TextEdit;
}

export interface ExportedArrow {
  name: string;
  signature: string;
  statement: VariableStatement;
}

export type ConfigProperty = PropertyAssignment & { readonly name: Identifier };
export type ConfigVariable = VariableDeclaration & { readonly type: TypeNode; readonly name: Identifier };

/** `const x: T = { items: [{ prop: (v) => ... }] }` as a callback property sees it. */
export interface ConfigDeclaration {
  property: ConfigProperty;
  array: ArrayLiteralExpression;
  variable: ConfigVariable;
  statement: Statement;
}

/** Where the helper text goes around the declaration. */
export interface HelperAnchors {
  top: number;
  above: number | undefined;
  aboveUsable: boolean;
  after: number;
}

/** A name a method reads: one of its own declarations, a global, or an import. */
export interface MethodReference {
  key: string;
  name?: string;
  imported?: StringLiteralImport;
  binding?: Node;
}

export interface MethodCandidate {
  site: MethodSite;
  shape: string;
  references: MethodReference[];
  referenceKeys: string;
}

export interface NewHelperModule {
  file: string;
  text: string;
  sharesNameWith?: string;
}
