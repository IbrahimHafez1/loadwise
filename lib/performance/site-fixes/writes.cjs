'use strict';

const {
  hasMultilineTemplate,
  ts,
  textOf,
  ancestor,
  calleeCall,
  indentationAt,
  lineStart,
  isPlainReference,
} = require('./helpers.cjs');

function withoutParentheses(node) {
  let current = node;
  while (current && ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function outsideParentheses(node) {
  let current = node;
  while (current.parent && ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return current;
}

function countAwaits(node) {
  let count = 0;
  (function visit(child) {
    if (ts.isAwaitExpression(child)) count++;
    ts.forEachChild(child, visit);
  })(node);
  return count;
}

function leftmostName(reference) {
  let current = reference;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current.text : 'this';
}

// ---- prisma-read-modify-write ----

const incrementOperators = new Map([
  [ts.SyntaxKind.PlusToken, 'increment'],
  [ts.SyntaxKind.MinusToken, 'decrement'],
]);

function isFieldRead(operand, fieldName) {
  const access = withoutParentheses(operand);
  return ts.isPropertyAccessExpression(access) && ts.isIdentifier(access.expression) && access.name.text === fieldName
    ? access
    : undefined;
}

function readModifyWrite({ node }) {
  const property = node.parent;
  if (!property || !ts.isPropertyAssignment(property) || property.name !== node || !ts.isIdentifier(node)) return;
  const expression = withoutParentheses(property.initializer);
  if (!ts.isBinaryExpression(expression)) return;
  const operation = incrementOperators.get(expression.operatorToken.kind);
  if (!operation) return;
  const leftRead = isFieldRead(expression.left, node.text);
  const rightRead = isFieldRead(expression.right, node.text);
  // Both sides reading a `.field` makes it unclear which one is the stale read.
  if (!leftRead === !rightRead) return;
  // `amount - row.field` is not a decrement of the column.
  if (rightRead && operation === 'decrement') return;
  const read = leftRead ?? rightRead;
  const amount = withoutParentheses(leftRead ? expression.right : expression.left);
  const usable =
    ts.isNumericLiteral(amount) ||
    (isPlainReference(amount) && leftmostName(amount) !== read.expression.text && !textOf(amount).includes('\n'));
  if (!usable) return;
  return {
    edits: [
      {
        start: property.initializer.getStart(),
        end: property.initializer.end,
        text: `{ ${operation}: ${textOf(amount)} }`,
      },
    ],
    note: 'The database applies the change atomically. If the earlier read is only used for this value, it can be removed.',
  };
}

// ---- pg-dynamic-query-text ----

// After a comparison operator (not JSON/array operators), LIKE, LIMIT or OFFSET a placeholder takes the value.
const valuePosition = /(?:(?<=[\w\s)"])(?:=|<>|!=|<=|>=|<|>)|\b(?:like|ilike|limit|offset))\s*$/i;
// Postgres binds parameters only in these statements; SET, SHOW, DDL and other utility statements reject $1.
const parameterizableStatement = /^[\s(]*(?:select|insert|update|delete|with)\b/i;
const identifierLikeExpression = /(?:table|column|\bcol\b|field|identifier|schema|sortBy|orderBy|direction)/i;

function templateLiteralText(literal) {
  const text = textOf(literal);
  return text.slice(1, text.length - (ts.isTemplateTail(literal) ? 1 : 2));
}

function isQueryMethod(callee) {
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'query';
  return ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
    ? callee.argumentExpression.text === 'query'
    : false;
}

function parameterizedSql(template) {
  const literals = [template.head, ...template.templateSpans.map((span) => span.literal)].map(templateLiteralText);
  if (literals.some((literal) => /[$\\]|--|\/\*/.test(literal))) return;
  if (!parameterizableStatement.test(literals[0])) return;
  const statementText = literals.join('?').replace(/;\s*$/, '');
  if (statementText.includes(';')) return;
  let sql = '';
  for (let index = 0; index < template.templateSpans.length; index++) {
    sql += literals[index];
    const quoted = sql.endsWith("'") && literals[index + 1].startsWith("'");
    if (quoted) {
      sql = sql.slice(0, -1);
      literals[index + 1] = literals[index + 1].slice(1);
    }
    const expression = template.templateSpans[index].expression;
    const expressionText = textOf(expression);
    const isSequence = ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken;
    if (isSequence || expressionText.includes('\n')) return;
    if (!quoted && (ts.isStringLiteralLike(expression) || identifierLikeExpression.test(expressionText))) return;
    // An odd quote count means the placeholder would sit inside a string literal or quoted identifier.
    if ((sql.match(/'/g) ?? []).length % 2 || (sql.match(/"/g) ?? []).length % 2) return;
    if (!valuePosition.test(sql)) return;
    const next = literals[index + 1];
    const isLast = index + 1 === template.templateSpans.length;
    if (!/^[\s),]/.test(next) && !(isLast && next === '')) return;
    sql += `$${index + 1}`;
  }
  return sql + literals.at(-1);
}

function dynamicQueryText({ node }) {
  const template = ancestor(node, ts.isTemplateExpression);
  const call = template?.parent;
  if (!call || !ts.isCallExpression(call) || call.arguments.length !== 1 || call.arguments[0] !== template) return;
  if (!isQueryMethod(call.expression)) return;
  const sql = parameterizedSql(template);
  if (sql === undefined) return;
  const quote = /['\n\r]/.test(sql) ? '`' : "'";
  const values = template.templateSpans.map((span) => textOf(span.expression));
  return {
    edits: [
      {
        start: template.getStart(),
        end: template.end,
        text: `${quote}${sql}${quote}, [${values.join(', ')}]`,
      },
    ],
    note: 'Values travel as parameters, so they can no longer change the SQL text. Table and column names still need an allowlist.',
  };
}

// ---- prisma-dependent-writes ----

const transactionParameter = 'tx';
// site-fix.cjs drops hunks longer than this, so longer rewrites use the in-place form.
const maxInlineLines = 14;

function prismaCreateCall(statement) {
  // Resolves `[client].[model].create(...)` out of `await <call>` when the awaited call is the statement's only await.
  if (countAwaits(statement) !== 1) return;
  let call;
  (function visit(child) {
    if (ts.isAwaitExpression(child)) call = withoutParentheses(child.expression);
    else ts.forEachChild(child, visit);
  })(statement);
  if (!call || !ts.isCallExpression(call) || call.questionDotToken) return;
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !['create', 'createMany'].includes(callee.name.text)) return;
  const model = callee.expression;
  if (!ts.isPropertyAccessExpression(model) || !isPlainReference(model.expression)) return;
  return { call, client: model.expression, awaited: outsideParentheses(call).parent };
}

function declaredNameOf(statement) {
  if (!ts.isVariableStatement(statement) || statement.modifiers?.length) return;
  const list = statement.declarationList;
  if (!(list.flags & ts.NodeFlags.Const) || list.declarations.length !== 1) return;
  const [declaration] = list.declarations;
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return;
  return declaration.name.text;
}

function usedOutside(block, name, start, end) {
  let used = false;
  (function visit(child) {
    if (used) return;
    if (ts.isIdentifier(child) && child.text === name && (child.end <= start || child.getStart() >= end)) {
      const parent = child.parent;
      const isLabel =
        (ts.isPropertyAccessExpression(parent) && parent.name === child) ||
        (ts.isPropertyAssignment(parent) && parent.name === child);
      if (!isLabel) used = true;
    }
    ts.forEachChild(child, visit);
  })(block);
  return used;
}

function mentionsName(node, name) {
  let found = false;
  (function visit(child) {
    if (ts.isIdentifier(child) && child.text === name) found = true;
    else ts.forEachChild(child, visit);
  })(node);
  return found;
}

function awaitedCreateOf(statement, call) {
  // The statement must be exactly `[const x =] await call;` or `return await call;`.
  const awaited = outsideParentheses(call).parent;
  if (!awaited || !ts.isAwaitExpression(awaited)) return;
  const holder = outsideParentheses(awaited).parent;
  if (ts.isExpressionStatement(holder) || ts.isReturnStatement(holder)) return holder === statement ? {} : undefined;
  if (
    ts.isVariableDeclaration(holder) &&
    holder.parent.declarations.length === 1 &&
    holder.parent.parent === statement &&
    holder.parent.flags & ts.NodeFlags.Const &&
    ts.isIdentifier(holder.name) &&
    !statement.modifiers?.length
  ) {
    return { name: holder.name.text };
  }
}

function dependentWrites({ node, text }) {
  const call = calleeCall(node);
  if (!call) return;
  const childStatement = ancestor(call, (current) => ts.isStatement(current) && ts.isBlock(current.parent));
  const block = childStatement?.parent;
  if (!block) return;
  const index = block.statements.indexOf(childStatement);
  const parentStatement = block.statements[index - 1];
  if (!parentStatement) return;
  const parentName = declaredNameOf(parentStatement);
  const child = prismaCreateCall(childStatement);
  const parent = prismaCreateCall(parentStatement);
  if (!parentName || !child || !parent || child.call !== call) return;
  if (textOf(child.client) !== textOf(parent.client)) return;
  const childResult = awaitedCreateOf(childStatement, child.call);
  const parentResult = awaitedCreateOf(parentStatement, parent.call);
  if (!childResult || parentResult?.name !== parentName) return;
  if (mentionsName(parentStatement, transactionParameter) || mentionsName(childStatement, transactionParameter)) return;

  const start = parentStatement.getStart();
  const end = childStatement.end;
  const isReturn = ts.isReturnStatement(childStatement);
  const exposed = [parentName, childResult.name].filter(
    (name) => name !== undefined && usedOutside(block, name, start, end),
  );
  if (isReturn && exposed.length) return;

  const clientText = textOf(child.client);
  const opener = `${isReturn ? 'return ' : bindingFor(exposed)}await ${clientText}.$transaction(async (${transactionParameter}) => {`;
  const closing = returnFor(exposed);
  const indentation = indentationAt(text, start);
  const unit = indentation.includes('\t') ? '\t' : '  ';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const nested = nestedRewrite({ text, start, end, clients: [child.client, parent.client], indentation, unit });
  if (nested && nested.length + 2 + (closing ? 1 : 0) <= maxInlineLines) {
    const lines = [opener, ...nested, ...(closing ? [indentation + unit + closing] : []), `${indentation}});`];
    return {
      edits: [{ start, end, text: lines.join(eol) }],
      note: 'Both writes now commit or roll back together; the transaction callback uses `tx` instead of the client.',
    };
  }
  // Too long to re-indent as one readable hunk: wrap the statements in place and leave indentation to the formatter.
  const openerStart = lineStart(text, start);
  if (text.slice(openerStart, start).trim()) return;
  const closingText = [...(closing ? [indentation + unit + closing] : []), `${indentation}});`].join(eol);
  return {
    edits: [
      { start: openerStart, end: openerStart, text: indentation + opener + eol },
      ...[child.client, parent.client].map((client) => ({
        start: client.getStart(),
        end: client.end,
        text: transactionParameter,
      })),
      { start: end, end, text: eol + closingText },
    ],
    note: 'Both writes now commit or roll back together; the transaction callback uses `tx` instead of the client. Run your formatter to re-indent the wrapped statements.',
  };
}

function bindingFor(exposed) {
  if (exposed.length === 2) return `const { ${exposed.join(', ')} } = `;
  return exposed.length ? `const ${exposed[0]} = ` : '';
}

function returnFor(exposed) {
  if (exposed.length === 2) return `return { ${exposed.join(', ')} };`;
  return exposed.length ? `return ${exposed[0]};` : undefined;
}

// The statements with the client swapped for `tx` and indented one level, or nothing when a multi-line template
// literal would have its text changed by the extra indentation.
function nestedRewrite({ text, start, end, clients, indentation, unit }) {
  const replacements = clients
    .map((client) => ({ start: client.getStart() - start, end: client.end - start }))
    .sort((left, right) => right.start - left.start);
  let body = text.slice(start, end);
  for (const replacement of replacements)
    body = body.slice(0, replacement.start) + transactionParameter + body.slice(replacement.end);
  if (hasMultilineTemplate(clients[0].getSourceFile(), start, end)) return;
  const lines = body.split(/\r?\n/).map((line, lineIndex) => (lineIndex === 0 || line === '' ? line : unit + line));
  lines[0] = indentation + unit + lines[0];
  return lines;
}

module.exports = {
  'prisma-read-modify-write': readModifyWrite,
  'pg-dynamic-query-text': dynamicQueryText,
  'prisma-dependent-writes': dependentWrites,
};
