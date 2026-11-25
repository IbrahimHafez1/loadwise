// Keyed by ts.SyntaxKind name; each check is (node, context) => void and reports through
// context.report.
import { checkJwtDecode, checkJwtVerify, checkJwtNone, checkJwtSign } from './jwt.js';
import { checkSecretComparison } from './comparison.js';
import { checkMathRandom } from './random.js';
import { checkWeakPasswordHash, checkBcryptCost } from './hashing.js';
import { checkStringLiteral, checkTemplateText, checkSigningKey } from './secrets.js';
import { checkPlaintextPassword } from './plaintext-password.js';
import * as rateLimits from './rate-limits.js';
import { checkTlsProperty, checkTlsAssignment, checkMysqlTls, checkCipher } from './transport-and-ciphers.js';

export const checks = {
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
};
