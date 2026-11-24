// Keyed by ts.SyntaxKind name; each check is (node, context) => void and reports through
// context.report.
import * as sql from './sql.cjs';
import * as nosql from './nosql.cjs';
import * as command from './command.cjs';
import { checkCode, checkTemplate } from './code.cjs';
import { checkCall as checkRegex, checkRegexOperator } from './regex.cjs';
import * as redos from './redos.cjs';
import type { SecurityCheckModule } from '../types/security-check.cjs';

export const checks: SecurityCheckModule['checks'] = {
  CallExpression: [sql.check, nosql.check, command.check, checkCode, checkTemplate, checkRegex, redos.checkCall],
  NewExpression: [checkCode, checkRegex],
  PropertyAssignment: [checkRegexOperator],
};
