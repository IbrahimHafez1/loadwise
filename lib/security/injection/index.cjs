'use strict';

// Keyed by ts.SyntaxKind name; each check is (node, context) => void and reports through context.report.
const sql = require('./sql.cjs');
const nosql = require('./nosql.cjs');

module.exports = {
  checks: {
    CallExpression: [sql.check, nosql.check],
  },
};
