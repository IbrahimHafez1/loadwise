'use strict';

// Keyed by ts.SyntaxKind name; each check is (node, context) => void and reports through context.report.
const { checkJwtDecode, checkJwtVerify, checkJwtNone, checkJwtSign } = require('./jwt.cjs');
const { checkSecretComparison } = require('./comparison.cjs');
const { checkMathRandom } = require('./random.cjs');
const { checkWeakPasswordHash, checkBcryptCost } = require('./hashing.cjs');
const { checkStringLiteral, checkTemplateText, checkSigningKey } = require('./secrets.cjs');
const { checkPlaintextPassword } = require('./plaintext-password.cjs');
const rateLimits = require('./rate-limits.cjs');
const { checkTlsProperty, checkTlsAssignment, checkMysqlTls, checkCipher } = require('./transport-and-ciphers.cjs');

module.exports = {
  checks: {
    CallExpression: [
      checkJwtDecode,
      checkJwtVerify,
      checkJwtSign,
      checkSigningKey,
      checkWeakPasswordHash,
      checkBcryptCost,
      checkMathRandom,
      checkMysqlTls,
      checkCipher,
      checkPlaintextPassword,
      rateLimits.checkCall,
    ],
    PropertyAssignment: [checkJwtNone, checkTlsProperty],
    BinaryExpression: [checkSecretComparison, checkTlsAssignment],
    StringLiteral: [checkStringLiteral],
    NoSubstitutionTemplateLiteral: [checkStringLiteral],
    TemplateHead: [checkTemplateText],
    TemplateMiddle: [checkTemplateText],
    TemplateTail: [checkTemplateText],
  },
};
