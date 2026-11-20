'use strict';

const { checkRequestUrl } = require('./ssrf.cjs');
const { checkFilePath } = require('./path-traversal.cjs');
const { checkArchiveWrite } = require('./zip-slip.cjs');
const { checkRedirectCall, checkNestRedirect } = require('./open-redirect.cjs');

// Keyed by ts.SyntaxKind name; each check is (node, context) => void and reports through context.report.
module.exports = {
  checks: {
    CallExpression: [checkRequestUrl, checkFilePath, checkArchiveWrite, checkRedirectCall],
    ReturnStatement: [checkNestRedirect],
  },
};
