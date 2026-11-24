// One pillar's analysis of a source file, as the scanners run it.
import type { SourceFile } from 'typescript';
import type { Finding, ProgramAdapter, RulePolicy } from '../../shared/types.cjs';
import type { PillarName } from '../../shared/types/pillar-name.cjs';

export interface SourceAnalyzer {
  pillar: PillarName;
  analyzeFile(
    program: ProgramAdapter,
    sourceFile: SourceFile,
    policy?: RulePolicy,
    forEachSourceCandidate?: ProgramAdapter['forEachSourceCandidate'],
  ): Finding[];
}
