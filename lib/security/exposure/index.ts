import * as cors from './cors.js';
import * as cookies from './cookies.js';
import * as errorResponses from './error-responses.js';
import * as graphql from './graphql.js';
import * as logging from './logging.js';
import * as massAssignment from './mass-assignment.js';
import * as prototypePollution from './prototype-pollution.js';
import * as reflectedXss from './reflected-xss.js';
import * as templateAutoescape from './template-autoescape.js';
import * as validationPipe from './validation-pipe.js';
import * as xml from './xml.js';
import * as passwordResponse from './password-response.js';
import * as storageAcl from './storage-acl.js';
import * as urlSecrets from './url-secrets.js';
import * as frontend from './frontend-security.js';
import * as backend from './backend-security-mastery.js';

// Keyed by ts.SyntaxKind name; each check is (node, context) => void and reports through
// context.report.
export const checks = {
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
  PropertyAssignment: [cors.checkCorsProperty, graphql.checkProperty, storageAcl.checkProperty, frontend.checkProperty],
};
