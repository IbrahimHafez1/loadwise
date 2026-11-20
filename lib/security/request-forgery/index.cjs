'use strict';

const { checkRequestUrl } = require('./ssrf.cjs');
const { checkRedirectCall, checkNestRedirect } = require('./open-redirect.cjs');

// Keyed by ts.SyntaxKind name; each check is (node, context) => void and reports through context.report.
module.exports = {
  checks: {
    CallExpression: [checkRequestUrl, checkRedirectCall],
    ReturnStatement: [checkNestRedirect],
  },
};
