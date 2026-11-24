import { checkRequestUrl } from './ssrf.cjs';
import { checkFilePath } from './path-traversal.cjs';
import { checkArchiveWrite } from './zip-slip.cjs';
import { checkRedirectCall, checkNestRedirect } from './open-redirect.cjs';
import { checkDiskStorage } from './upload-filename.cjs';
import type { SecurityCheckModule } from '../types/security-check.cjs';

// Keyed by ts.SyntaxKind name; each check is (node, context) => void and reports through
// context.report.
export const checks: SecurityCheckModule['checks'] = {
  CallExpression: [checkRequestUrl, checkFilePath, checkArchiveWrite, checkRedirectCall, checkDiskStorage],
  ReturnStatement: [checkNestRedirect],
};
