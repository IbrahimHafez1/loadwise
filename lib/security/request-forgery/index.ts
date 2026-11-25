import { checkRequestUrl } from './ssrf.js';
import { checkFilePath } from './path-traversal.js';
import { checkArchiveWrite } from './zip-slip.js';
import { checkRedirectCall, checkNestRedirect } from './open-redirect.js';
import { checkDiskStorage } from './upload-filename.js';
import type { SecurityCheckModule } from '../types/security-check.js';

// Keyed by ts.SyntaxKind name; each check is (node, context) => void and reports through
// context.report.
export const checks: SecurityCheckModule['checks'] = {
  CallExpression: [checkRequestUrl, checkFilePath, checkArchiveWrite, checkRedirectCall, checkDiskStorage],
  ReturnStatement: [checkNestRedirect],
};
