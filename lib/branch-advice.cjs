'use strict';

const ts = require('typescript');
const maximumComparisonLines = 17;
const maximumComparisonCharacters = 1500;

function sourceLines(node, source) {
  const first = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const last = source.getLineAndCharacterOfPosition(node.end - 1).line + 1;
  return first === last ? 'line ' + first : 'lines ' + first + '–' + last;
}

function simpleName(node) {
  if (node && ts.isIdentifier(node)) return node.text;
  if (node && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name))
    return ts.isIdentifier(node.expression) ? node.expression.text + '.' + node.name.text : node.name.text;
}

// The main walk has already counted each statement's decisions and excluded nested callbacks.
function sectionAdvice(section, source) {
  if (!section) return;
  const lines = sourceLines(section, source);
  if (ts.isSwitchStatement(section)) {
    const selector = simpleName(section.expression);
    return `Extract one outcome from the switch${selector ? ' on ' + selector : ''} at ${lines}, preserving fallthrough and default handling.`;
  }
  if (ts.isIterationStatement(section, false))
    return `Extract the per-iteration work at ${lines}, keeping iteration order and early exits in the loop.`;
  if (ts.isTryStatement(section))
    return `Extract the work inside the try at ${sourceLines(section.tryBlock, source)}. Keep the call inside the try to preserve failure and cleanup behavior.`;
  if (ts.isReturnStatement(section))
    return `Extract the return calculation at ${lines} into a named operation that preserves short-circuit evaluation.`;
  if (ts.isIfStatement(section))
    return `Extract the work selected by the condition at ${lines}, keeping the original return paths and side-effect order.`;
  return `Isolate the decisions at ${lines} in a named operation and pass its result to the surrounding code.`;
}

function nestingAdvice(branch, source) {
  if (!ts.isIfStatement(branch)) return sectionAdvice(branch, source);
  if (
    ts.isBinaryExpression(branch.expression) &&
    [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(branch.expression.operatorToken.kind)
  )
    return `Give the compound condition at ${sourceLines(branch.expression, source)} a domain name and evaluate it at this point to preserve short-circuit order.`;
  const statement = branch.thenStatement;
  if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
    const name = simpleName(statement.expression.expression);
    if (name)
      return `Group the condition and the call to ${name} at ${sourceLines(branch, source)} in one operation. Keep argument evaluation inside the guard.`;
  }
  const outer = branch.parent && ts.isBlock(branch.parent) ? branch.parent.parent : undefined;
  if (outer && ts.isIfStatement(outer) && outer.thenStatement === branch.parent)
    return `Isolate the branch starting at ${sourceLines(outer.expression, source)} as one operation, keeping its nested conditions and state updates in order.`;
  return sectionAdvice(branch, source);
}

// Flip a nested branch only when the next statement is already an unconditional continue.
// Its then-body moves out one scope; limit it to statements that introduce no block bindings.
function loopGuardComparison(branch, source) {
  if ([ts.ScriptKind.TSX, ts.ScriptKind.JSX].includes(source.scriptKind)) return;
  const body = branch.parent;
  const outer = body?.parent;
  if (
    !outer ||
    !ts.isIfStatement(outer) ||
    body !== outer.thenStatement ||
    !ts.isBlock(body) ||
    !outer.elseStatement ||
    !ts.isBlock(outer.elseStatement) ||
    !ts.isBlock(outer.parent) ||
    !body.statements.every((statement) => ts.isExpressionStatement(statement) || ts.isIfStatement(statement))
  )
    return;
  const statements = outer.parent.statements;
  const exit = statements[statements.indexOf(outer) + 1];
  if (!exit || !ts.isContinueStatement(exit) || exit.label) return;
  const lineOf = (offset) => source.getLineAndCharacterOfPosition(offset).line;
  const first = lineOf(outer.getStart(source));
  const last = lineOf(exit.end - 1);
  const separator = lineOf(body.end - 1) - first;
  const close = lineOf(outer.end - 1) - first;
  const start = source.getPositionOfLineAndCharacter(first, 0);
  if (
    last - first + 1 > maximumComparisonLines ||
    exit.end - start > maximumComparisonCharacters ||
    close !== last - first - 1
  )
    return;
  const raw = source.text.slice(start, exit.end).split(/\r?\n/);
  const indent = raw[0].match(/^[ \t]*/)[0];
  if (!raw.every((line) => !line || line.startsWith(indent))) return;
  const lines = raw.map((line) => line.slice(indent.length));
  const condition = outer.expression.getText(source);
  if (
    lines[0] !== `if (${condition}) {` ||
    lines[separator] !== '} else {' ||
    lines[close] !== '}' ||
    lines[close + 1] !== 'continue;' ||
    lineOf(outer.elseStatement.getStart(source)) !== first + separator
  )
    return;
  const thenLines = lines.slice(1, separator);
  const elseLines = lines.slice(separator + 1, close);
  const step = thenLines[0]?.match(/^[ \t]+/)?.[0];
  if (!step || !elseLines.length || !thenLines.every((line) => !line || line.startsWith(step))) return;
  // Dedenting raw multiline literal text would change its value.
  if (lines.some((line) => /[\x60\\]/.test(line))) return;
  let negation = `!(${condition})`;
  if (ts.isIdentifier(outer.expression)) negation = '!' + condition;
  else if (ts.isBinaryExpression(outer.expression)) {
    const { operatorToken } = outer.expression;
    const inverse =
      operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        ? '!=='
        : operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
          ? '==='
          : undefined;
    if (inverse) {
      const index = operatorToken.getStart(source) - outer.expression.getStart(source);
      negation = condition.slice(0, index) + inverse + condition.slice(index + inverse.length);
    }
  }
  return {
    line: first + 1,
    before: lines.join('\n'),
    code: [
      `if (${negation}) {`,
      ...elseLines,
      step + 'continue;',
      '}',
      ...thenLines.map((line) => line.slice(step.length)),
      'continue;',
    ].join('\n'),
    inline: `if (${condition}) { … } else { … } → if (${negation}) { …; continue; }`,
    note: 'Run the original else body and continue immediately when the condition is false. The true path now sits one level closer to the loop.',
    language: source.scriptKind === ts.ScriptKind.JS ? 'javascript' : 'typescript',
  };
}

module.exports = { nestingAdvice, sectionAdvice, loopGuardComparison };
