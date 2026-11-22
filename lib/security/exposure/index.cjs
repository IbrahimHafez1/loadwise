'use strict';

const cors = require('./cors.cjs');
const cookies = require('./cookies.cjs');
const errorResponses = require('./error-responses.cjs');
const graphql = require('./graphql.cjs');
const logging = require('./logging.cjs');
const massAssignment = require('./mass-assignment.cjs');
const prototypePollution = require('./prototype-pollution.cjs');
const reflectedXss = require('./reflected-xss.cjs');
const templateAutoescape = require('./template-autoescape.cjs');
const validationPipe = require('./validation-pipe.cjs');
const xml = require('./xml.cjs');

// Keyed by ts.SyntaxKind name; each check is (node, context) => void and reports through context.report.
module.exports = {
  checks: {
    BinaryExpression: [
      errorResponses.checkAssignment,
      prototypePollution.checkAssignment,
      reflectedXss.checkAssignment,
    ],
    CallExpression: [
      cookies.checkCall,
      cors.checkCall,
      errorResponses.checkCall,
      logging.check,
      massAssignment.checkCall,
      prototypePollution.checkCall,
      reflectedXss.checkCall,
      templateAutoescape.check,
      xml.check,
    ],
    NewExpression: [errorResponses.checkNew, massAssignment.checkNew, templateAutoescape.check, validationPipe.check],
    PropertyAssignment: [cors.checkCorsProperty, graphql.checkProperty],
  },
};
