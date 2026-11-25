import { ts } from './compiler.js';
import type { Node } from 'typescript';
import type { FunctionWithBody } from '../shared/types/function-summaries.js';

function isAsyncFunction(node: Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))
  );
}

function hasFunctionBody(node: Node): node is FunctionWithBody {
  return ts.isFunctionLike(node) && 'body' in node && Boolean(node.body);
}

export { isAsyncFunction, hasFunctionBody };
