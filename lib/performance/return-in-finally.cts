import { loadSyntax } from './compiler.cjs';
import type { Node, ReturnStatement } from 'typescript';
import type { PerformanceRuleContext } from '../shared/types.cjs';
const ts = loadSyntax();

function checkReturnInFinally(statement: ReturnStatement, { report }: PerformanceRuleContext) {
  for (
    let child: Node = statement, parent: Node | undefined = child.parent;
    parent;
    child = parent, parent = parent.parent
  ) {
    if (ts.isFunctionLike(parent)) return;
    if (ts.isTryStatement(parent) && child === parent.finallyBlock) {
      report(
        statement,
        'return-in-finally',
        'Returning from `finally` can replace a pending return value or suppress a thrown error. Keep cleanup in `finally` and return from `try`, `catch`, or after the `try` statement.',
      );
      return;
    }
  }
}

export { checkReturnInFinally };
