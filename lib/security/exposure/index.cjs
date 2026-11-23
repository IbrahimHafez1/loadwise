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
const passwordResponse = require('./password-response.cjs');
const storageAcl = require('./storage-acl.cjs');
const urlSecrets = require('./url-secrets.cjs');
const frontend = require('./frontend-security.cjs');
const backend = require('./backend-security-mastery.cjs');

// Keyed by ts.SyntaxKind name; each check is (node, context) => void and reports through context.report.
module.exports = {
  checks: {
    BinaryExpression: [
      errorResponses.checkAssignment,
      prototypePollution.checkAssignment,
      reflectedXss.checkAssignment,
      frontend.checkAssignment,
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
      passwordResponse.checkCall,
      graphql.checkCall,
      urlSecrets.checkCall,
      frontend.checkCall,
      backend.checkCall,
    ],
    NewExpression: [
      errorResponses.checkNew,
      massAssignment.checkNew,
      templateAutoescape.check,
      validationPipe.check,
      graphql.checkServer,
    ],
    PropertyAccessExpression: [urlSecrets.checkPropertyAccess],
    JsxAttribute: [frontend.checkJsxAttribute],
    PropertyAssignment: [
      cors.checkCorsProperty,
      graphql.checkProperty,
      storageAcl.checkProperty,
      frontend.checkProperty,
    ],
  },
};
