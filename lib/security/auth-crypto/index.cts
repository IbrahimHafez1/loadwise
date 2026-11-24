// Keyed by ts.SyntaxKind name; each check is (node, context) => void and reports through
// context.report.
import { checkJwtDecode, checkJwtVerify, checkJwtNone, checkJwtSign } from './jwt.cjs';
import { checkSecretComparison } from './comparison.cjs';
import { checkMathRandom } from './random.cjs';
import { checkWeakPasswordHash, checkBcryptCost } from './hashing.cjs';
import { checkStringLiteral, checkTemplateText, checkSigningKey } from './secrets.cjs';
import { checkPlaintextPassword } from './plaintext-password.cjs';
import * as rateLimits from './rate-limits.cjs';
import { checkTlsProperty, checkTlsAssignment, checkMysqlTls, checkCipher } from './transport-and-ciphers.cjs';

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
