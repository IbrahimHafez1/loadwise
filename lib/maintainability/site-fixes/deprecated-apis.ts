import ts from 'typescript';
import { declaresName, isBufferConstruction } from '../deprecated-apis.js';
import type { Expression, Node, SourceFile } from 'typescript';
import type { FixResult, SiteFixBuilder, SiteFixInput } from '../../shared/types.js';

const urlModules: readonly string[] = ['url', 'node:url'];

// The call the finding starts at: its offset is the start of the `new`, the callee or the receiver.
function flaggedCall(
  { finding, node, sourceFile }: SiteFixInput & { sourceFile: SourceFile; node: Node },
  isCandidate: (candidate: Node) => candidate is ts.NewExpression | ts.CallExpression,
): ts.NewExpression | ts.CallExpression | undefined {
  if (finding.line === undefined || finding.column === undefined) return;
  const offset = sourceFile.getPositionOfLineAndCharacter(finding.line - 1, finding.column - 1);
  return ts.findAncestor(
    node,
    (candidate): candidate is ts.NewExpression | ts.CallExpression =>
      isCandidate(candidate) && candidate.getStart(sourceFile) === offset,
  );
}

// `new Buffer(5)` allocates, `new Buffer('text')` copies; which one a variable means is unknowable.
function bufferReplacement(argumentsList: readonly Expression[]): string | undefined {
  const [first, second] = argumentsList;
  if (!first || argumentsList.length > 2) return;
  if (ts.isNumericLiteral(first)) return argumentsList.length === 1 ? 'Buffer.alloc' : undefined;
  const copiesText = ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first);
  if (copiesText || (ts.isArrayLiteralExpression(first) && second === undefined)) return 'Buffer.from';
  return;
}

function replaceBufferConstruction(input: SiteFixInput): FixResult | undefined {
  const { node, sourceFile } = input;
  if (!node || !sourceFile || declaresName(sourceFile, 'Buffer', ['buffer', 'node:buffer'])) return;
  const call = flaggedCall({ ...input, node, sourceFile }, isBufferConstruction);
  const replacement = call && bufferReplacement(call.arguments ?? []);
  if (!call || !replacement) return;
  return {
    edits: [{ start: call.getStart(sourceFile), end: call.expression.end, text: replacement }],
    note: 'A literal argument says whether the buffer is allocated or copied, so the explicit factory means the same thing.',
  };
}

function isParseCall(candidate: Node): candidate is ts.CallExpression {
  return (
    ts.isCallExpression(candidate) &&
    ts.isPropertyAccessExpression(candidate.expression) &&
    candidate.expression.name.text === 'parse'
  );
}

function isUrlParseCall(candidate: Node): candidate is ts.NewExpression | ts.CallExpression {
  return isParseCall(candidate) || (ts.isCallExpression(candidate) && ts.isIdentifier(candidate.expression));
}

function replaceUrlParse(input: SiteFixInput): FixResult | undefined {
  const { node, sourceFile } = input;
  if (!node || !sourceFile || declaresName(sourceFile, 'URL', urlModules)) return;
  const call = flaggedCall({ ...input, node, sourceFile }, isUrlParseCall);
  if (!call || !ts.isCallExpression(call) || call.arguments.length !== 1 || ts.isSpreadElement(call.arguments[0]))
    return;
  return {
    edits: [{ start: call.getStart(sourceFile), end: call.expression.end, text: 'new URL' }],
    requiresReview: true,
    note: 'Not a drop-in: `new URL()` throws on relative input and has no `path`, `auth` or `query` fields. Check how the result is read.',
  };
}

const builders: Record<string, SiteFixBuilder> = {
  'deprecated-node-api': (input) => {
    const message = input.finding.message;
    if (message.startsWith('`new Buffer()`')) return replaceBufferConstruction(input);
    if (message.startsWith('`url.parse()`')) return replaceUrlParse(input);
    return;
  },
};

export default builders;
