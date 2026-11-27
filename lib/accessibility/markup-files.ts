// The markup files outside the TypeScript program: .html, .htm, .vue and .svelte. They are listed under the scanned
// folders with the same exclusions the source pass uses (ignored and build folders, minified and vendored files, the
// config's "ignore" paths, --staged and --changed-since), then read one by one.
import fs from 'node:fs';
import path from 'node:path';
import { isVendoredMinified } from '../shared/execution-context.js';
import { recordSkippedFile } from '../performance/scan-outcome.js';
import type { Finding, ScanResult, SkippedFile } from '../shared/types.js';
import { listFrontendCandidateFiles } from './frontend-detect.js';
import { checkTemplateFile } from './template-file.js';

const markupFilePattern = /\.(?:html?|vue|svelte)$/i;

function isMarkupFile(filename: string): boolean {
  return markupFilePattern.test(filename);
}

interface MarkupScanInput {
  /** The folders to list markup files in; empty when files are named explicitly. */
  roots: readonly string[];
  /** Markup files named on the command line, read whether or not a scope or ignore rule would list them. */
  explicitFiles: readonly string[];
  /** Whether a listed file is scanned: the config's ignore paths and the changed files. */
  isScanned?: (absoluteFile: string) => boolean;
}

function listedMarkupFiles({ roots, isScanned }: Pick<MarkupScanInput, 'roots' | 'isScanned'>): string[] {
  const files = roots.flatMap((root) =>
    listFrontendCandidateFiles(root)
      .filter((file) => isMarkupFile(file) && !isVendoredMinified(file))
      .map((file) => path.resolve(root, file)),
  );
  return files.filter((absolute) => isScanned?.(absolute) ?? true);
}

/** The findings of one markup file; a file that cannot be read or analyzed is recorded as skipped instead. */
function findingsOfFile(absolute: string, skippedFiles: SkippedFile[]): Finding[] {
  const file = path.relative(process.cwd(), absolute).split(path.sep).join('/');
  try {
    // The absolute path lets Angular .html templates find their component's sibling .ts file; findings report the path
    // relative to the working directory, as program findings do.
    return checkTemplateFile(absolute, fs.readFileSync(absolute, 'utf8')).map((finding) => ({ ...finding, file }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordSkippedFile(
      skippedFiles,
      { file, reason: message },
      `The accessibility analysis of ${file} failed (${message}). Skipped that file.`,
    );
    return [];
  }
}

/** The accessibility findings of every markup file the input selects, and how many files were read. */
function scanMarkupFiles(input: MarkupScanInput): ScanResult {
  const files = new Set([...input.explicitFiles.map((file) => path.resolve(file)), ...listedMarkupFiles(input)]);
  const skippedFiles: SkippedFile[] = [];
  const findings = [...files].flatMap((file) => findingsOfFile(file, skippedFiles));
  return { scannedFiles: files.size - skippedFiles.length, findings, ...(skippedFiles.length && { skippedFiles }) };
}

export { isMarkupFile, scanMarkupFiles };
