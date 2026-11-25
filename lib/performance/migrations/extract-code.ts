// Syntax-only extraction from TypeORM, Knex, Sequelize and MikroORM migration modules. No type
// checker and no native engine: the receiver of a call is recognized by its name, and only the `up`
// direction is read.

import ts from 'typescript';
import { createOperation } from './operations.js';
import type { CallExpression, Node } from 'typescript';
import type { MigrationDialect, MigrationOperation } from '../types/migration-operations.js';
import { builderOperations, isRawSqlCall, rawSqlOperations } from './extract-code-builders.js';
import {
  defaultTransaction,
  detectFramework,
  findDeclaration,
  findUpFunctions,
  isFunctionLike,
  propertyName,
  scriptKindFor,
  unwrapExpression,
} from './extract-code-discovery.js';
import {
  EMPTY_BINDINGS,
  calleeParts,
  isInsideTransactionCallback,
  positionOf,
  receiverName,
} from './extract-code-sql.js';
import type {
  Bindings,
  CodeContext,
  ExtractedUnit,
  FunctionLike,
  HelperBinding,
  Scope,
  UnitContext,
  UpTarget,
} from './extract-code-types.js';

const MAX_HELPER_DEPTH = 3;

// `this.helper(...)` resolves to a method of the migration class; `helper(...)` to a function
// declared in the file.
function sameFileHelper(call: CallExpression, owner: Node | undefined): FunctionLike | null {
  const callee = unwrapExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    const declared = findDeclaration(call, callee.text);
    return isFunctionLike(declared) ? declared : null;
  }
  if (!ts.isPropertyAccessExpression(callee) || callee.expression.kind !== ts.SyntaxKind.ThisKeyword) return null;
  if (!owner || !ts.isClassLike(owner)) return null;
  const name = callee.name.text;
  for (const member of owner.members) {
    if (propertyName(member.name) !== name) continue;
    if (ts.isMethodDeclaration(member)) return member;
    if (ts.isPropertyDeclaration(member) && isFunctionLike(member.initializer)) return member.initializer;
  }
  return null;
}

// Helper parameters bound to the call-site arguments, read in the caller's bindings.
function helperBindings(helper: FunctionLike, call: CallExpression, bindings: Bindings) {
  const bound = new Map<string, HelperBinding>();
  helper.parameters.forEach((parameter, index) => {
    if (ts.isIdentifier(parameter.name)) bound.set(parameter.name.text, { node: call.arguments[index], bindings });
  });
  return bound;
}

// The helper parameter that receives the migration's runner (`queryRunner`, `knex`, ...), if any.
function helperRunnerParameter(helper: FunctionLike, call: CallExpression, context: UnitContext) {
  const index = call.arguments.findIndex(
    (argument) => unwrapExpression(argument).getText(context.sourceFile) === context.firstParameter,
  );
  return index === -1 ? context.firstParameter : helper.parameters[index]?.name.getText(context.sourceFile);
}

function helperCallOperations(call: CallExpression, context: UnitContext, scope: Scope): MigrationOperation[] {
  if (scope.helpers.length > MAX_HELPER_DEPTH) return [];
  const helper = sameFileHelper(call, scope.owner);
  if (!helper?.body || scope.helpers.includes(helper)) return [];
  const helperContext: UnitContext = {
    ...context,
    firstParameter: helperRunnerParameter(helper, call, context),
    bindings: helperBindings(helper, call, context.bindings),
  };
  // Each operation is reported at the call, so every call (and its table) gets its own line.
  return functionOperations(helper, helperContext, { ...scope, helpers: [...scope.helpers, helper] }).map(
    (operation) => ({ ...operation, ...positionOf(call, context.sourceFile) }),
  );
}

function functionOperations(fn: FunctionLike, context: UnitContext, scope: Scope): MigrationOperation[] {
  const operations: MigrationOperation[] = [];
  const visit = (node: Node) => {
    if (!ts.isCallExpression(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    const parts = calleeParts(node);
    if (parts) {
      const receiverText = receiverName(parts.receiver, context.sourceFile);
      const found = isRawSqlCall(parts.method, receiverText, context)
        ? rawSqlOperations(node, context)
        : builderOperations(node, parts.method, receiverText, context);
      if (found.length > 0) {
        // The receiver of a chained builder call (`schema.createTable(...).alterTable(...)`) runs
        // first. Arguments, including Knex alterTable callbacks, were already read with their call.
        visit(parts.receiver);
        const explicitTransaction = scope.explicitTransaction || isInsideTransactionCallback(node, fn);
        for (const fields of found) {
          operations.push(createOperation({ file: context.file, ...fields, explicitTransaction }));
        }
        return;
      }
    }
    const helperOperations = helperCallOperations(node, context, {
      ...scope,
      explicitTransaction: scope.explicitTransaction || isInsideTransactionCallback(node, fn),
    });
    if (helperOperations.length > 0) {
      ts.forEachChild(node, visit);
      operations.push(...helperOperations);
      return;
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return operations;
}

function upFunctionOperations(upFunction: UpTarget, owner: Node, context: CodeContext): MigrationOperation[] {
  if (!isFunctionLike(upFunction)) return [];
  const firstParameter = upFunction.parameters[0]?.name.getText(context.sourceFile);
  const unitContext: UnitContext = { ...context, firstParameter, bindings: EMPTY_BINDINGS };
  return functionOperations(upFunction, unitContext, { owner, helpers: [upFunction], explicitTransaction: false });
}

function extractCodeFile(text: string, { file, dialect }: { file: string; dialect: MigrationDialect }) {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const framework = detectFramework(text);
  const context: CodeContext = { sourceFile, file, dialect, framework };
  const units: ExtractedUnit[] = findUpFunctions(sourceFile).map(({ fn, owner }) => ({
    inTransaction: defaultTransaction(framework, owner, sourceFile),
    operations: upFunctionOperations(fn, owner, context),
  }));
  return { framework, units };
}

// Helper modules kept next to migrations (shared SQL, support utilities) define no `up` and are not
// migrations.
function definesUpFunction(text: string, file: string) {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  return findUpFunctions(sourceFile).length > 0;
}

export { extractCodeFile, detectFramework, definesUpFunction };
