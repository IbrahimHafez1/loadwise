import * as cors from './cors.cjs';
import * as cookies from './cookies.cjs';
import * as errorResponses from './error-responses.cjs';
import * as graphql from './graphql.cjs';
import * as logging from './logging.cjs';
import * as massAssignment from './mass-assignment.cjs';
import * as prototypePollution from './prototype-pollution.cjs';
import * as reflectedXss from './reflected-xss.cjs';
import * as templateAutoescape from './template-autoescape.cjs';
import * as validationPipe from './validation-pipe.cjs';
import * as xml from './xml.cjs';
import * as passwordResponse from './password-response.cjs';
import * as storageAcl from './storage-acl.cjs';
import * as urlSecrets from './url-secrets.cjs';
import * as frontend from './frontend-security.cjs';
import * as backend from './backend-security-mastery.cjs';

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
