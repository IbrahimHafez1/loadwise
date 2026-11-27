import type { Finding, SiteFixInput } from '../../shared/types.js';
import type { CallExpression, SourceFile } from 'typescript';

export interface BatchedFixInput {
  finding: Finding;
  call: CallExpression;
  sourceFile: SourceFile;
  load: SiteFixInput['load'];
}
