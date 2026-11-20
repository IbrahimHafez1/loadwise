'use strict';

const { ts, textOf, ancestor } = require('./helpers.cjs');

// ---- pg-dynamic-query-text ----

// After a comparison operator (not JSON/array operators), LIKE, LIMIT or OFFSET a placeholder takes the value.
const valuePosition = /(?:(?<=[\w\s)"])(?:=|<>|!=|<=|>=|<|>)|\b(?:like|ilike|limit|offset))\s*$/i;
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

module.exports = {
  'pg-dynamic-query-text': dynamicQueryText,
};
