'use strict';

// Keyed by ts.SyntaxKind name; each check is (node, context) => void and reports through context.report.
module.exports = { checks: {} };
