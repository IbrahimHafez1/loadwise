import ts from 'typescript';
import { walkNodes } from './walk.js';
import { generatedSource } from './duplicates.js';
import { isVendoredMinified } from '../shared/execution-context.js';
import { isVendoredOrSamplePath } from './source-exclusions.js';
import type { Node, SourceFile } from 'typescript';
import type { Finding } from '../shared/types.js';

const TEST_FILE =
  /(?:^|\/)(?:tests?|__tests__|specs?|e2e|integration-tests?|cypress)\/|\.(?:test|spec|e2e|e2e-spec|cy)\.[cm]?[jt]sx?$/i;
// Code generators (GraphQL codegen, Prisma, OpenAPI clients) write casts and directives the team cannot edit.
const GENERATED_PATH = /(?:^|\/)(?:__generated__|generated[\w-]*|gen)\/|\.(?:generated|gen)\.[cm]?[jt]sx?$/i;
const TYPESCRIPT_FILE = /\.[cm]?tsx?$/i;
const FOCUSABLE_RUNNERS = new Set(['describe', 'it', 'test', 'suite']);
// Jasmine's focused forms, which are plain functions rather than `.only` members.
const JASMINE_FOCUSED = new Set(['fit', 'fdescribe']);
const SUPPRESSION_DIRECTIVE = /^(?:\/\/\/?|\/\*+)\s*@ts-(ignore|expect-error|nocheck)\b(.*)$/s;
const WATCHED_DIRECTIVE = /@ts-(?:ignore|expect-error|nocheck)/;

// `test.concurrent.only(...)` and `test.describe.serial.only(...)` still focus the runner.
const RUNNER_MODIFIERS = new Set(['concurrent', 'sequential', 'serial', 'parallel', 'describe']);

// A runner imported under another name (`import { test as nodeTest } from 'node:test'`) is still a runner.
function runnerNamesOf(sourceFile: SourceFile): Set<string> {
  const names = new Set(FOCUSABLE_RUNNERS);
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const specifier of bindings.elements) {
      if (specifier.propertyName && FOCUSABLE_RUNNERS.has(specifier.propertyName.text)) {
        names.add(specifier.name.text);
      }
    }
  }
  return names;
}

function isFocusableRunner(node: Node, runnerNames: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(node)) return runnerNames.has(node.text);
  if (ts.isCallExpression(node)) {
    // `it.each(cases).only(...)`
    const callee = node.expression;
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'each' &&
      isFocusableRunner(callee.expression, runnerNames)
    );
  }
  return (
    ts.isPropertyAccessExpression(node) &&
    RUNNER_MODIFIERS.has(node.name.text) &&
    isFocusableRunner(node.expression, runnerNames)
  );
}

function focusedMemberName(node: Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
}

function isInvokedMember(node: Node): boolean {
  const { parent } = node;
  if (ts.isCallExpression(parent)) return parent.expression === node;
  return ts.isTaggedTemplateExpression(parent) && parent.tag === node;
}

function isFocusedMember(node: Node, runnerNames: ReadonlySet<string>): boolean {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
  if (focusedMemberName(node) !== 'only' || !isFocusableRunner(node.expression, runnerNames)) return false;
  // `it.only(...)` and `describe.only.each(table)(...)` run focused; a bare `it.only` or `it.only.each` reference does not.
  const { parent } = node;
  if (isInvokedMember(node)) return true;
  return (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    parent.name.text === 'each' &&
    isInvokedMember(parent)
  );
}

function isJasmineFocusedCall(node: Node): boolean {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return false;
  if (!JASMINE_FOCUSED.has(node.expression.text)) return false;
  // `fit` is also a common name outside test runners, so a title string must lead the arguments.
  const [title] = node.arguments;
  return title !== undefined && ts.isStringLiteralLike(title);
}

function findingAt(
  sourceFile: SourceFile,
  file: string,
  position: number,
  { ruleId, message }: { ruleId: string; message: string },
): Finding {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
  return { file, line: line + 1, column: character + 1, ruleId, message };
}

function isExcludedSource(file: string, sourceFile: SourceFile): boolean {
  const normalized = file.replaceAll('\\', '/');
  return (
    isVendoredOrSamplePath(normalized) ||
    GENERATED_PATH.test(normalized) ||
    /\.d\.[cm]?ts$/i.test(normalized) ||
    isVendoredMinified(file) ||
    Boolean(generatedSource(sourceFile, file))
  );
}

function isTestFile(file: string): boolean {
  return TEST_FILE.test(file.replaceAll('\\', '/'));
}

function checkFocusedTests(sourceFile: SourceFile, file: string): Finding[] {
  if (!isTestFile(file) || !/\bonly\b|\bf(?:it|describe)\b/.test(sourceFile.text)) return [];
  const findings: Finding[] = [];
  const runnerNames = runnerNamesOf(sourceFile);
  walkNodes(sourceFile, (node) => {
    if (!isFocusedMember(node, runnerNames) && !isJasmineFocusedCall(node)) return;
    findings.push(
      findingAt(sourceFile, file, node.getStart(sourceFile), {
        ruleId: 'focused-test-committed',
        message:
          'A focused test (`.only`, `fit` or `fdescribe`) makes the runner skip every other test, so CI passes while most of the suite never runs. Remove the focus before committing.',
      }),
    );
  });
  return findings;
}

function suppressionReason(commentText: string): { directive: string; hasReason: boolean } | undefined {
  const match = SUPPRESSION_DIRECTIVE.exec(commentText);
  if (!match) return;
  // Text after the directive counts as a reason only when it holds a word, so `-` or `*/` alone do not.
  const afterDirective = match[2].replace(/\*\/\s*$/, '');
  return { directive: match[1], hasReason: /[\p{L}\p{N}]/u.test(afterDirective) };
}

function commentRangesOf(sourceFile: SourceFile): ts.CommentRange[] {
  const seenPositions = new Set<number>();
  const seenComments = new Set<number>();
  const ranges: ts.CommentRange[] = [];
  walkNodes(sourceFile, (node) => {
    if (seenPositions.has(node.pos)) return;
    seenPositions.add(node.pos);
    // A directive after code on the same line (`setup(); // @ts-ignore`) is a trailing comment of the previous token.
    const found = [
      ...(ts.getLeadingCommentRanges(sourceFile.text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(sourceFile.text, node.pos) ?? []),
    ];
    for (const range of found) {
      if (seenComments.has(range.pos)) continue;
      seenComments.add(range.pos);
      ranges.push(range);
    }
  });
  return ranges;
}

function checkSuppressionReasons(sourceFile: SourceFile, file: string): Finding[] {
  if (!WATCHED_DIRECTIVE.test(sourceFile.text)) return [];
  const findings: Finding[] = [];
  for (const range of commentRangesOf(sourceFile)) {
    const result = suppressionReason(sourceFile.text.slice(range.pos, range.end));
    if (!result || result.hasReason) continue;
    findings.push(
      findingAt(sourceFile, file, range.pos, {
        ruleId: 'ts-suppression-without-reason',
        message: `\`@ts-${result.directive}\` silences the compiler with no explanation, so a later reader cannot tell whether the error is still real. Add the reason after the directive, or fix the type error.`,
      }),
    );
  }
  return findings;
}

function unwrapParentheses(node: Node): Node {
  return ts.isParenthesizedExpression(node) ? unwrapParentheses(node.expression) : node;
}

function isDoubleAssertion(node: Node): boolean {
  if (!ts.isAsExpression(node)) return false;
  const inner = unwrapParentheses(node.expression);
  return (
    ts.isAsExpression(inner) &&
    (inner.type.kind === ts.SyntaxKind.UnknownKeyword || inner.type.kind === ts.SyntaxKind.AnyKeyword)
  );
}

function checkDoubleTypeAssertions(sourceFile: SourceFile, file: string): Finding[] {
  // Tests cast through `unknown` to build partial mocks, which is the accepted way to do it there.
  if (!TYPESCRIPT_FILE.test(file) || isTestFile(file)) return [];
  // A comment may sit between `as` and the type, so the cheap prefilter only looks for both words.
  if (!/\bas\b/.test(sourceFile.text) || !/\b(?:unknown|any)\b/.test(sourceFile.text)) return [];
  const findings: Finding[] = [];
  walkNodes(sourceFile, (node) => {
    if (!isDoubleAssertion(node)) return;
    findings.push(
      findingAt(sourceFile, file, node.getStart(sourceFile), {
        ruleId: 'double-type-assertion',
        message:
          'Casting through `unknown` or `any` to a second type turns the type checker off for this value, so a wrong shape fails at runtime instead. Narrow the value with a type guard or validate it, or fix the declared type.',
      }),
    );
  });
  return findings;
}

function checkTypeSafetyHygiene(sourceFile: SourceFile, file: string): Finding[] {
  if (isExcludedSource(file, sourceFile)) return [];
  return [
    ...checkFocusedTests(sourceFile, file),
    ...checkSuppressionReasons(sourceFile, file),
    ...checkDoubleTypeAssertions(sourceFile, file),
  ];
}

export { checkTypeSafetyHygiene };
