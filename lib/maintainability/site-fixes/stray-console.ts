import ts from 'typescript';
import { consoleMethodOf, loggerReplacement } from '../stray-console.js';
import type { SiteFixBuilder, SiteFixInput } from '../../shared/types.js';

function strayConsoleFix({ node, sourceFile }: SiteFixInput) {
  if (!node || !sourceFile) return;
  const call = ts.findAncestor(node, (candidate) => consoleMethodOf(candidate) !== undefined);
  if (!call || !ts.isCallExpression(call)) return;
  const target = loggerReplacement(sourceFile, call);
  if (!target) return;
  return {
    edits: [{ start: call.expression.getStart(sourceFile), end: call.expression.end, text: target.replacement }],
    requiresReview: true,
    note: 'Routes the call through the logger already in this file. Check that the logger accepts these arguments (structured loggers such as pino take the data object first), and that the level suits the message.',
  };
}

const builders: Record<string, SiteFixBuilder> = {
  'stray-console': strayConsoleFix,
};

export default builders;
