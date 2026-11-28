// The reliability rules that run as their own analyzer in the shared source pass. The reliability rules that grew up
// inside the performance analyzer still run there; the pass labels every finding by its rule's registered pillar.
import { checkSwallowedErrors } from './swallowed-errors.js';
import { checkInsertTerminators } from './sql-insert-terminator.js';
import { checkSuspiciousLogic } from './suspicious-logic.js';
import { checkBoundaryAccess } from './boundary-access.js';
import { checkResourceLeaks } from './resource-leaks.js';
import { checkChildProcesses } from './child-process.js';
import { checkErrorValues } from './error-values.js';
import { checkReactBugs } from './react-bugs.js';
import { checkSwitchExhaustive } from './switch-exhaustive.js';
import { checkPoolTimeout } from './pool-timeout.js';
import { checkUncaughtException } from './uncaught-exception.js';
import { isVendoredMinified } from '../shared/execution-context.js';
import { relativeToProject, reviewedReason, reviewMarkers } from '../performance/review-context.js';
import type { SourceFile } from 'typescript';
import type { Finding, ProgramAdapter } from '../shared/types.js';

function analyzeFile(program: ProgramAdapter, sourceFile: SourceFile): Finding[] {
  if (sourceFile.isDeclarationFile || isVendoredMinified(sourceFile.fileName)) return [];
  // The rules recognise test and vendored folders by the path inside the project, not above it.
  const file = relativeToProject(sourceFile.fileName).split('\\').join('/');
  const checker = program.getTypeChecker();
  const findings = [
    ...checkSwallowedErrors(sourceFile, file),
    ...checkInsertTerminators(sourceFile, file),
    ...checkSuspiciousLogic(sourceFile, file, program.getCompilerOptions()),
    ...checkBoundaryAccess(sourceFile, file, checker),
    ...checkResourceLeaks(sourceFile, file, checker),
    ...checkChildProcesses(sourceFile, file, checker),
    ...checkErrorValues(sourceFile, file),
    ...checkReactBugs(sourceFile, file, checker, program.getCompilerOptions().jsxImportSource),
    ...checkSwitchExhaustive(sourceFile, file, checker),
    ...checkPoolTimeout(sourceFile, file, checker),
    ...checkUncaughtException(sourceFile, file, checker),
  ];
  const hasReviewComments = reviewMarkers.some((marker) => sourceFile.text.includes(marker));
  return findings.map((finding) => {
    const reason = hasReviewComments ? reviewedReason(sourceFile, (finding.line ?? 1) - 1, finding.ruleId) : undefined;
    return { ...finding, file: sourceFile.fileName, ...(reason && { contextualReason: reason }) };
  });
}

export { analyzeFile };
