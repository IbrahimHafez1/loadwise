// Keyed by ts.SyntaxKind name; each check is (node, context) => void and reports through
// context.report.
import * as sql from './sql.js';
import * as nosql from './nosql.js';
import * as command from './command.js';
import { checkCode, checkTemplate } from './code.js';
import { checkCall as checkRegex, checkRegexOperator } from './regex.js';
import * as redos from './redos.js';
import type { SecurityCheckModule } from '../types/security-check.js';

export const checks: SecurityCheckModule['checks'] = {
  CallExpression: [sql.check, nosql.check, command.check, checkCode, checkTemplate, checkRegex, redos.checkCall],
  NewExpression: [checkCode, checkRegex],
  PropertyAssignment: [checkRegexOperator],
};
