import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { isVendoredOrSamplePath } from './source-exclusions.js';
import type { Finding } from '../shared/types.js';

const TSCONFIG_FILE = /(?:^|\/)tsconfig(?:\.[\w-]+)*\.json$/i;
// Configs that exist to compile tests, tooling or sample projects are allowed to be looser.
const NON_PRODUCTION_CONFIG =
  /(?:^|[./_-])(?:test|tests|spec|e2e|jest|vitest|cypress|playwright|storybook)(?:[./_-]|$)/i;
const NON_PRODUCTION_FOLDER = /(?:^|\/)(?:tests?|__tests__|e2e|templates?|boilerplates?|starters?)\//i;
const LOOSENED_CHECKS = ['strictNullChecks', 'noImplicitAny'];

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  return object.properties
    .filter(ts.isPropertyAssignment)
    .find(
      (property) =>
        (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name)) && property.name.text === name,
    );
}

function isFalse(property: ts.PropertyAssignment | undefined): property is ts.PropertyAssignment {
  return property?.initializer.kind === ts.SyntaxKind.FalseKeyword;
}

function compilerOptionsOf(sourceFile: ts.JsonSourceFile): ts.ObjectLiteralExpression | undefined {
  const [statement] = sourceFile.statements;
  const root = statement?.expression;
  if (!root || !ts.isObjectLiteralExpression(root)) return;
  const initializer = objectProperty(root, 'compilerOptions')?.initializer;
  return initializer && ts.isObjectLiteralExpression(initializer) ? initializer : undefined;
}

function strictnessProblem(options: ts.ObjectLiteralExpression): ts.PropertyAssignment | undefined {
  const strict = objectProperty(options, 'strict');
  if (strict) return isFalse(strict) ? strict : undefined;
  // Without `strict`, an explicit opt-out of the two checks that matter most is the same decision.
  return LOOSENED_CHECKS.map((name) => objectProperty(options, name)).find(isFalse);
}

function checkTsconfig(root: string, file: string): Finding[] {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const sourceFile = ts.parseJsonText(file, text);
  const options = compilerOptionsOf(sourceFile);
  const problem = options && strictnessProblem(options);
  if (!problem) return [];
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(problem.getStart(sourceFile));
  return [
    {
      file,
      line: line + 1,
      column: character + 1,
      ruleId: 'tsconfig-strict-disabled',
      message:
        'This tsconfig turns off strict type checking, so null and undefined values and implicit `any` types pass the compiler and fail at runtime. Enable `"strict": true`, or turn it on in steps by fixing the errors per flag.',
    },
  ];
}

function isProductionTsconfig(file: string): boolean {
  const normalized = file.replaceAll('\\', '/');
  return (
    TSCONFIG_FILE.test(normalized) &&
    !isVendoredOrSamplePath(normalized) &&
    !NON_PRODUCTION_FOLDER.test(normalized) &&
    !NON_PRODUCTION_CONFIG.test(path.posix.basename(normalized))
  );
}

function checkTsconfigStrictness(root: string, inventory: readonly string[]): Finding[] {
  return inventory.filter(isProductionTsconfig).flatMap((file) => {
    try {
      return checkTsconfig(root, file);
    } catch {
      // An unreadable config is not this rule's finding.
      return [];
    }
  });
}

export { checkTsconfigStrictness };
