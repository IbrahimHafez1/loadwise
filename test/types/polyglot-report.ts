import assert from 'node:assert/strict';
import type { Finding, SkippedFile } from '../../lib/shared/types.js';
import type { SourceLocation } from '../../lib/maintainability/types/polyglot-scan.js';

/** A checker's `--json` output as the CLI tests read it. */
export interface CliJsonReport {
  findings: Finding[];
  skippedFiles: SkippedFile[];
}

/** The part of the optional `@ast-grep/cli` postinstall script that locates the parser binary. */
export interface AstGrepPostinstall {
  resolveBinaryPath(): string;
}

/** The files of the other sites a duplicate-implementation finding points at. */
export function relatedFilesOf(finding: Finding): string[] {
  const { related } = finding;
  assert.ok(Array.isArray(related), 'expected related locations');
  const locations: readonly SourceLocation[] = related;
  return locations.map((site) => site.file);
}
