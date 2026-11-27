import { originalProgram } from './isolated-program.js';
import { ts, lineStart, lineEnd, indentationAt, newlineOf, blank, ownsLines, hasMultilineLiteral } from './helpers.js';
import { forOwnNodes, leavesFunction, placementOf, receiverUse } from './extract-block-ast.js';
import { dataFlowOf, typedParameters } from './extract-block-flow.js';
import { narrowingLost } from './extract-block-narrowing.js';
import { builderName, helperName, memberNameTaken } from './extract-block-naming.js';
import { maxHunkLines } from './extract-block-measure.js';
import type { Node, SourceFile, Statement } from 'typescript';
import type { TextEdit } from '../../shared/types.js';
import type { FunctionWithBody } from '../types/site-fix-nodes.js';
import type { ExtractionPlan, HelperSignature, SignatureInput } from '../types/extract-block.js';

// A shorter statement gains nothing from a name of its own.
const minExtractedLines = 3;
const maxSignatureLength = 100;
const typeScriptFile = /\.[cm]?tsx?$/i;
// Without semicolons, a following line that starts with one of these would continue the inserted
// call.
const continuingLine = /^\s*[([`+\-/]/;

// One indentation step, read from the statement and the line that opens its block.
function indentationStep(statement: Statement, sourceFile: SourceFile): string | undefined {
  const text = sourceFile.text;
  const own = indentationAt(text, statement.getStart(sourceFile));
  const outer = indentationAt(text, statement.parent.getStart(sourceFile));
  if (own.startsWith(outer) && own.length > outer.length) return own.slice(outer.length);
}

// The lines from `first` to the end of `statement` re-indented to `indentation`, or undefined when
// a line sits left of them.
function movedLines(
  statement: Statement,
  sourceFile: SourceFile,
  indentation: string,
  first: Statement = statement,
): string[] | undefined {
  const text = sourceFile.text;
  const own = indentationAt(text, first.getStart(sourceFile));
  const lines = text.slice(lineStart(text, first.getStart(sourceFile)), statement.end).split('\n');
  if (lines.some((line) => !blank(line) && !line.startsWith(own))) return;
  return lines.map((line) => (blank(line) ? line.replace(/^[ \t]+/, '') : indentation + line.slice(own.length)));
}

// Code written without semicolons gets none either.
function usesSemicolons(fn: FunctionWithBody, sourceFile: SourceFile): boolean {
  let withSemicolon = 0;
  let without = 0;
  forOwnNodes(fn.body, (node: Node) => {
    if (!ts.isExpressionStatement(node) && !ts.isVariableStatement(node)) return;
    if (sourceFile.text[node.end - 1] === ';') withSemicolon++;
    else without++;
  });
  return withSemicolon >= without;
}

// Whether `statement` fills whole lines and is big enough, but not too big, to be worth a function
// of its own.
function isMovableStatement(statement: Statement, sourceFile: SourceFile): boolean {
  if (!ts.isBlock(statement.parent) || !ownsLines(statement) || hasMultilineLiteral(statement)) return false;
  const lineCount = sourceFile.text.slice(statement.getStart(sourceFile), statement.end).split('\n').length;
  return lineCount >= minExtractedLines && lineCount <= maxHunkLines && !leavesFunction(statement);
}

// The new function's name, parameter list and indentation step, or undefined when any of them
// cannot be chosen safely.
function helperSignatureOf({
  statement,
  sourceFile,
  placement,
  flow,
  typeScript,
  checker,
}: SignatureInput): HelperSignature | undefined {
  const { container, method } = placement;
  const { returned, built, variables } = flow;
  const parameters = typeScript
    ? typedParameters(variables, returned, checker, container.parent)
    : variables.map((variable) => variable.symbol.name);
  const step = indentationStep(statement, sourceFile);
  const name = built ? builderName(built.variable, sourceFile) : helperName(statement, sourceFile);
  if (!parameters || !step || !name) return;
  if (method && ts.isClassLike(container.parent) && memberNameTaken(container.parent, name, checker)) return;
  return { name, parameters, step };
}

// Everything the edits are built from, or undefined when the statement cannot be moved without
// changing behaviour.
export function extractionPlan(
  statement: Statement,
  fn: FunctionWithBody,
  sourceFile: SourceFile,
): ExtractionPlan | undefined {
  if (!isMovableStatement(statement, sourceFile)) return;
  const receiver = receiverUse(statement);
  if (receiver === 'blocked') return;
  const placement = placementOf(statement, receiver === 'this');
  if (!placement) return;
  const { container } = placement;
  const checker = originalProgram(sourceFile).getTypeChecker();
  const flow = dataFlowOf(statement, container, checker);
  if (!flow) return;
  const typeScript = typeScriptFile.test(sourceFile.fileName);
  if (typeScript && narrowingLost(statement, fn, checker, flow.variables, flow.built?.variable.declaration)) return;
  const plan = { statement, fn, sourceFile, placement, flow, typeScript };
  const signature = helperSignatureOf({ ...plan, checker });
  if (!signature) return;
  const text = sourceFile.text;
  if (!blank(text.slice(container.end, lineEnd(text, container.end)))) return;
  return { ...plan, signature };
}

// Code written without semicolons gets none either; empty when none is wanted, undefined when
// leaving it out would let the next line continue the inserted call.
function statementEnding({ statement, fn, sourceFile }: ExtractionPlan): string | undefined {
  const ending = usesSemicolons(fn, sourceFile) ? ';' : '';
  if (!ending && continuingLine.test(sourceFile.text.slice(statement.end))) return;
  return ending;
}

function methodKeyword(method: boolean, typeScript: boolean): string {
  if (!method) return 'function ';
  return typeScript ? 'private ' : '';
}

// The text of the new function, to go after the enclosing member or top-level statement.
function helperDeclarationText(
  { statement, sourceFile, placement, flow, signature, typeScript }: ExtractionPlan,
  ending: string,
): string | undefined {
  const { method, container } = placement;
  const { returned, built } = flow;
  const { name, parameters, step } = signature;
  const text = sourceFile.text;
  const newline = newlineOf(text);
  const outerIndentation = indentationAt(text, container.getStart(sourceFile));
  const header = `${outerIndentation}${methodKeyword(method, typeScript)}${name}(${parameters.join(', ')}) {`;
  const declarationStatement = built?.declarationStatement;
  if (declarationStatement && (!ownsLines(declarationStatement) || hasMultilineLiteral(declarationStatement))) return;
  const body = movedLines(statement, sourceFile, outerIndentation + step, declarationStatement);
  if (!body || header.length > maxSignatureLength) return;
  const returnedName = built ? built.variable.symbol.name : returned?.symbol.name;
  const returnLine = returnedName ? `${newline}${outerIndentation}${step}return ${returnedName}${ending}` : '';
  return `${newline}${newline}${header}${newline}${body.join('\n')}${returnLine}${newline}${outerIndentation}}`;
}

// The line that replaces the statement with a call to the new function.
function callLineText(
  { statement, sourceFile, placement, flow, signature }: ExtractionPlan,
  ending: string,
): string | undefined {
  const { returned, built, variables } = flow;
  const indentation = indentationAt(sourceFile.text, statement.getStart(sourceFile));
  const callee = (placement.method ? 'this.' : '') + signature.name;
  const assignment = built ? `const ${built.variable.symbol.name} = ` : returned ? `${returned.symbol.name} = ` : '';
  const call = `${assignment}${callee}(${variables.map((variable) => variable.symbol.name).join(', ')})${ending}`;
  if (indentation.length + call.length > maxSignatureLength) return;
  return indentation + call;
}

export function extractionEdits(plan: ExtractionPlan): TextEdit[] | undefined {
  const { statement, sourceFile, placement, flow } = plan;
  const ending = statementEnding(plan);
  if (ending === undefined) return;
  const declaration = helperDeclarationText(plan, ending);
  const callLine = callLineText(plan, ending);
  if (!declaration || !callLine) return;
  const start = lineStart(sourceFile.text, (flow.built?.declarationStatement ?? statement).getStart(sourceFile));
  return [
    { start, end: statement.end, text: callLine },
    { start: placement.container.end, end: placement.container.end, text: declaration },
  ];
}
