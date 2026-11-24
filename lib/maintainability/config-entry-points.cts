import ts from 'typescript';
import { walkNodes } from './walk.cjs';
import type { Node, SourceFile } from 'typescript';

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
]);

function stringsOf(expression: Node): string[] {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isArrayLiteralExpression(expression)) return expression.elements.flatMap(stringsOf);
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
