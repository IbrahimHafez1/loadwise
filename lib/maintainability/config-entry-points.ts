import ts from 'typescript';
import { walkNodes } from './walk.js';
import type { CallExpression, Node, SourceFile } from 'typescript';

// Tool configs that name source files by path: test runners, bundlers and Playwright/Cypress.
const configFile =
  /(?:^|\/)(?:(?:vite|vitest|jest|playwright|cypress|rollup|webpack|tsup|karma|ava)[\w.-]*\.config\.[cm]?[jt]s|\.mocharc\.[cm]?js)$/;
const jsonConfigFile = /(?:^|\/)(?:\.mocharc\.json|jest\.config\.json)$/;

// Only options that load a file or run a set of files; `exclude` or `include` lists say nothing
// about use.
const fileOptions = new Set([
  'globalSetup',
  'globalTeardown',
  'setupFiles',
  'setupFilesAfterEnv',
  'setupFilesAfterEach',
  'spec',
  'file',
  'require',
  'input',
  'entry',
  'testDir',
]);

function callFilePath(call: CallExpression): string | undefined {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return;
  const receiver = ts.skipOuterExpressions(callee.expression);
  const method = callee.name.text;
  if (method === 'resolve' && ts.isIdentifier(receiver) && receiver.text === 'require' && call.arguments.length === 1) {
    const first = ts.skipOuterExpressions(call.arguments[0]);
    return ts.isStringLiteralLike(first) ? first.text : undefined;
  }
  const baseArg = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  const anchoredAtDir =
    baseArg !== undefined &&
    ((ts.isIdentifier(baseArg) && baseArg.text === '__dirname') ||
      (ts.isPropertyAccessExpression(baseArg) &&
        baseArg.name.text === 'dirname' &&
        ts.isMetaProperty(baseArg.expression) &&
        baseArg.expression.keywordToken === ts.SyntaxKind.ImportKeyword));
  if (
    (method === 'resolve' || method === 'join') &&
    ts.isIdentifier(receiver) &&
    receiver.text === 'path' &&
    call.arguments.length >= 2 &&
    anchoredAtDir
  ) {
    const segments: string[] = [];
    for (const argument of call.arguments.slice(1)) {
      const part = ts.skipOuterExpressions(argument);
      if (!ts.isStringLiteralLike(part)) return;
      segments.push(part.text);
    }
    return segments.join('/');
  }
}

function stringsOf(expression: Node): string[] {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isCallExpression(expression)) {
    const resolved = callFilePath(expression);
    return resolved !== undefined ? [resolved] : [];
  }
  if (ts.isArrayLiteralExpression(expression)) return expression.elements.flatMap(stringsOf);
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.flatMap((property) =>
      ts.isPropertyAssignment(property) ? stringsOf(ts.skipOuterExpressions(property.initializer)) : [],
    );
  }
  return [];
}

function stringsOfJson(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.flatMap(stringsOfJson) : [];
}

// Paths from file options in a config script, relative to the config's folder.
function configFilePaths(sourceFile: SourceFile): string[] {
  const paths: string[] = [];
  walkNodes(sourceFile, (node: Node) => {
    if (!ts.isPropertyAssignment(node) || !(ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) return;
    if (fileOptions.has(node.name.text)) paths.push(...stringsOf(ts.skipOuterExpressions(node.initializer)));
  });
  return paths;
}

function jsonConfigFilePaths(config: Readonly<Record<string, unknown>>): string[] {
  return [...fileOptions].flatMap((option) => stringsOfJson(config[option]));
}

export { configFile, jsonConfigFile, configFilePaths, jsonConfigFilePaths };
