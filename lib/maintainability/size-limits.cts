import ts from 'typescript';
import { walkNodes } from './walk.cjs';
import { functionAnchor } from './functions.cjs';
import { generatedSource } from './duplicates.cjs';
import { testSourcePattern } from './snapshot-context.cjs';
import { defaultLimits } from './limits.cjs';
import type { ClassLikeDeclaration, Node, ParameterDeclaration, SignatureDeclaration, SourceFile } from 'typescript';
import type { LocatedFinding } from './types/module-graph.cjs';
import type { SizeLimits } from './types/policy.cjs';

// Lines that hold at least one token, so comments and blank lines are not counted.
function linesOfCode(sourceFile: SourceFile): number {
  const codeLines = new Set<number>();
  const pending: Node[] = [sourceFile];
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (ts.isJSDoc(node) || node.kind === ts.SyntaxKind.EndOfFileToken) continue;
    const children = node.getChildren(sourceFile);
    if (children.length) {
      // Spreading a list of hundreds of thousands of children into push() overflows the call stack.
      for (const child of children) pending.push(child);
      continue;
    }
    const first = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
    const last = sourceFile.getLineAndCharacterOfPosition(node.end).line;
    for (let line = first; line <= last; line++) codeLines.add(line);
  }
  return codeLines.size;
}

// Plain data properties (entities, DTOs) are not behaviour, so only methods, accessors and
// function-valued fields count.
function behaviourMembers(classNode: ClassLikeDeclaration): number {
  return classNode.members.filter(
    (member) =>
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessor(member) ||
      ts.isSetAccessor(member) ||
      ts.isConstructorDeclaration(member) ||
      (ts.isPropertyDeclaration(member) &&
        member.initializer &&
        (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))),
  ).length;
}

// Constructor parameter lists are injection lists when a decorator or parameter property is
// involved.
function isInjectionConstructor(node: Node): boolean {
  return (
    ts.isConstructorDeclaration(node) &&
    (Boolean(ts.getDecorators(node.parent)?.length) ||
      node.parameters.some((parameter) => ts.getDecorators(parameter)?.length || ts.getModifiers(parameter)?.length))
  );
}

// Decorated parameters (`@Body()`, `@Param()`) are filled in by a framework rather than chosen by a
// caller.
function callerSuppliedParameters(node: SignatureDeclaration): ParameterDeclaration[] {
  return node.parameters.filter(
    (parameter: ParameterDeclaration) =>
      !ts.getDecorators(parameter)?.length && !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'),
  );
}

function checkSizeLimits(sourceFile: SourceFile, file: string, limits: SizeLimits = defaultLimits): LocatedFinding[] {
  if (testSourcePattern.test(file) || generatedSource(sourceFile, file)) return [];
  const findings: LocatedFinding[] = [];
  function report(node: Node, ruleId: string, message: string): void {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({ file, line: position.line + 1, column: position.character + 1, ruleId, message });
  }

  const lineCount = sourceFile.getLineStarts().length;
  if (lineCount > limits.largeModuleLines) {
    const lines = linesOfCode(sourceFile);
    if (lines > limits.largeModuleLines) {
      findings.push({
        file,
        line: 1,
        column: 1,
        ruleId: 'large-module',
        message: `This module has ${lines} lines of code (limit ${limits.largeModuleLines}, comments and blank lines excluded). A file this long mixes responsibilities and is hard to navigate. Split it by responsibility into modules that each have one reason to change, and keep the current file as the entry point that re-exports them if callers depend on it.`,
      });
    }
  }

  walkNodes(sourceFile, (node: Node) => {
    if (ts.isClassLike(node)) {
      const count = behaviourMembers(node);
      if (count > limits.largeClassMembers) {
        report(
          node.name ?? node,
          'large-class',
          `This class has ${count} methods and accessors (limit ${limits.largeClassMembers}). A class this wide usually owns several responsibilities. Group the methods that share state into their own classes and have this one delegate to them.`,
        );
      }
      return;
    }
    if (!ts.isFunctionLike(node) || !('body' in node) || !node.body || isInjectionConstructor(node)) return;
    const count = callerSuppliedParameters(node).length;
    if (count > limits.longParameterCount) {
      report(
        functionAnchor(node, node.parent),
        'long-parameter-list',
        `This function takes ${count} parameters (limit ${limits.longParameterCount}). Long positional lists are easy to call in the wrong order. Group related parameters into one options object, and make the call sites name each value.`,
      );
    }
  });
  return findings;
}

export { checkSizeLimits };
