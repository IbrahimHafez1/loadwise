// Signature text of a generated batch sibling: modifiers, parameters with the item one turned into
// a list, and the return type.
import { ts, textOf } from './helpers.cjs';
import type { ParameterDeclaration, SyntaxKind, TypeNode } from 'typescript';
import type { HelperFunction } from '../types/helper-function.cjs';

interface SignatureInput {
  declaration: HelperFunction;
  batchName: string;
  itemIndex: number;
  listName: string;
  typed: boolean;
  returnType: string | undefined;
}

function arrayType(typeNode: TypeNode): string {
  const text = textOf(typeNode);
  return ts.isUnionTypeNode(typeNode) || ts.isFunctionTypeNode(typeNode) ? `(${text})[]` : `${text}[]`;
}

const keptModifierKinds: ReadonlySet<SyntaxKind> = new Set([
  ts.SyntaxKind.PrivateKeyword,
  ts.SyntaxKind.ProtectedKeyword,
  ts.SyntaxKind.PublicKeyword,
  ts.SyntaxKind.StaticKeyword,
]);

function modifiersText(declaration: HelperFunction): string {
  const kept = (declaration.modifiers ?? []).filter((modifier) => keptModifierKinds.has(modifier.kind));
  const exported =
    ts.isFunctionDeclaration(declaration) &&
    declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  return [
    ...(exported ? ['export'] : []),
    ...kept.map(textOf),
    'async',
    ...(ts.isFunctionDeclaration(declaration) ? ['function'] : []),
  ].join(' ');
}

export function signatureText({
  declaration,
  batchName,
  itemIndex,
  listName,
  typed,
  returnType,
}: SignatureInput): string {
  const parameters = declaration.parameters.map((parameter: ParameterDeclaration, index: number) => {
    if (index !== itemIndex) return textOf(parameter);
    return typed && parameter.type ? `${listName}: ${arrayType(parameter.type)}` : listName;
  });
  const result = typed && returnType ? `: Promise<${returnType}>` : '';
  return `${modifiersText(declaration)} ${batchName}(${parameters.join(', ')})${result} {`;
}
