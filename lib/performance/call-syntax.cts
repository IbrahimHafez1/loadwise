import { loadSyntax } from './compiler.cjs';
import type { CallExpression, Node } from 'typescript';
import type { FunctionWithBody } from '../shared/types/function-summaries.cjs';
const ts = loadSyntax();

// TypeScript's own helper for stepping over parentheses, assertions and non-null operators; it is
// not in the public typings.
declare module 'typescript' {
  function skipOuterExpressions(node: Expression, kinds?: number): Expression;
}

function skipParentheses(node: Node): Node {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function calleeName(call: CallExpression, unwrap?: (node: Node) => Node): string | undefined {
  const callee = unwrap ? unwrap(call.expression) : ts.skipOuterExpressions(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
}

// The path of a declaration below node_modules (`@types/node/fs.d.ts`), or undefined for project
// code.
function modulePathOf(declaration: Node): string | undefined {
  const filename = declaration.getSourceFile().fileName.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const start = filename.lastIndexOf(marker);
  return start < 0 ? undefined : filename.slice(start + marker.length);
}

// A function-like declaration that has a body, so overloads and ambient signatures are left out.
function isFunctionWithBody(node: Node | undefined): node is FunctionWithBody {
  return node !== undefined && ts.isFunctionLike(node) && 'body' in node && Boolean(node.body);
}

export { calleeName, isFunctionWithBody, modulePathOf, skipParentheses };
