'use strict';

// Keyed by ts.SyntaxKind name; each check is (node, context) => void and reports through context.report.
const sql = require('./sql.cjs');
const nosql = require('./nosql.cjs');
const command = require('./command.cjs');
const { checkCode, checkTemplate } = require('./code.cjs');
const { checkCall: checkRegex, checkRegexOperator } = require('./regex.cjs');

module.exports = {
  checks: {
    CallExpression: [sql.check, nosql.check, command.check, checkCode, checkTemplate, checkRegex],
    NewExpression: [checkCode, checkRegex],
    PropertyAssignment: [checkRegexOperator],
  },
};
