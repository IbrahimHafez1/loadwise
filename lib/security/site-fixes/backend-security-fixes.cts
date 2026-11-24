// Rule id -> build({ finding, node, sourceFile, text, load }) => { edits, note } | undefined; see
// lib/performance/site-fix.cjs. jwt-fallback-weak-secret has no builder: that rule was folded into
// hardcoded-secret.
import { requireReview, ts, calleeCall, nameTaken, indentationAt } from '../../performance/site-fixes/helpers.cjs';
import type { Expression, Node, SourceFile, Statement, VariableDeclaration } from 'typescript';
import type { FixResult, SiteFixBuilder, SiteFixInput, TextEdit } from '../../shared/types.cjs';

const HELMET_NAME = 'helmet';

function unwrapAwait(expression: Expression) {
  let value = ts.skipOuterExpressions(expression);
  while (ts.isAwaitExpression(value)) value = ts.skipOuterExpressions(value.expression);
  return value;
}

function createsServerApp(initializer: Expression | undefined) {
  const value = initializer && unwrapAwait(initializer);
  if (!value || !ts.isCallExpression(value)) return false;
  if (ts.isIdentifier(value.expression)) return value.expression.text === 'express';
  const callee = value.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'NestFactory' &&
    callee.name.text === 'create'
  );
}

// The statement `const app = express()` / `await NestFactory.create(...)` of the one app named
// `appName` in the file.
function appStatement(sourceFile: SourceFile, appName: string) {
  const matches: VariableDeclaration[] = [];
  (function visit(node: Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === appName &&
      createsServerApp(node.initializer)
    )
      matches.push(node);
    ts.forEachChild(node, visit);
  })(sourceFile);
  const statement = matches.length === 1 && matches[0].parent.parent;
  return statement && ts.isVariableStatement(statement) ? statement : undefined;
}

function isRequireStatement(statement: Statement) {
  if (!ts.isVariableStatement(statement)) return false;
  return statement.declarationList.declarations.some((declaration) => {
    const value = declaration.initializer && ts.skipOuterExpressions(declaration.initializer);
    return (
      value && ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'require'
    );
  });
}

// The import line in the file's own module style, placed after its last import; undefined when the
// style is unclear.
function importEdit(sourceFile: SourceFile, newline: string): TextEdit | undefined {
  const statements = sourceFile.statements;
  const lastImport = statements.findLast(ts.isImportDeclaration);
  if (lastImport) return { start: lastImport.end, end: lastImport.end, text: `${newline}import helmet from 'helmet';` };
  if (statements.some(ts.isImportEqualsDeclaration)) return;
  const lastRequire = statements.findLast(isRequireStatement);
  if (!lastRequire) return;
  return { start: lastRequire.end, end: lastRequire.end, text: `${newline}const helmet = require('helmet');` };
}

// Registers helmet right after the app is created, so the routes added later get the headers.
function expressHelmetFix({ node, sourceFile, text }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile || text === undefined) return;
  const call = calleeCall(node);
  const receiver = call && ts.isPropertyAccessExpression(call.expression) && call.expression.expression;
  if (!receiver || !ts.isIdentifier(receiver) || nameTaken(sourceFile, HELMET_NAME)) return;
  const statement = appStatement(sourceFile, receiver.text);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const importInsertion = importEdit(sourceFile, newline);
  if (!statement || !importInsertion) return;
  const indentation = indentationAt(text, statement.getStart(sourceFile));
  return {
    edits: [
      importInsertion,
      { start: statement.end, end: statement.end, text: `${newline}${indentation}${receiver.text}.use(helmet());` },
    ],
    note: 'Install the `helmet` package (`npm install helmet`).',
  };
}

const builders: Record<string, SiteFixBuilder> = {
  'express-missing-helmet': requireReview(
    "helmet's default Content-Security-Policy and cross-origin headers can block inline scripts, third-party embeds and cross-origin resources; check they fit the frontend.",
    expressHelmetFix,
  ),
};

export default builders;
