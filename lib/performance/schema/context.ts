import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SchemaSnapshot } from '../types/db-snapshot.js';

const supportedVersion = 1;
const dialects = new Set(['postgres', 'mysql', 'mongo']);

// Rules read the snapshot inside analyzeFile, which both engines call without a CLI options
// channel.
let activeSnapshot: SchemaSnapshot | undefined;

function invalid(detail: string): Error {
  // The snapshot path may be user-chosen, but its contents are never echoed so stray data cannot
  // leak.
  return new Error('Invalid schema snapshot: ' + detail + '.');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegative(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateRoundTrip(roundTrip: unknown): void {
  if (roundTrip === undefined) return;
  if (!isPlainObject(roundTrip) || !isNonNegative(roundTrip.medianMs)) throw invalid('roundTrip.medianMs');
  if (typeof roundTrip.runs !== 'number' || !Number.isSafeInteger(roundTrip.runs) || roundTrip.runs < 1)
    throw invalid('roundTrip.runs');
  if (roundTrip.kind !== 'measured') throw invalid('roundTrip.kind');
}

function validateIndex(index: unknown, label: string): void {
  if (!isPlainObject(index) || !Array.isArray(index.keys) || !index.keys.every(isPlainObject)) {
    throw invalid(label + ' keys');
  }
}

function validateTable(name: string, table: unknown): void {
  const label = 'table ' + JSON.stringify(name);
  if (!isPlainObject(table)) throw invalid(label);
  if (table.rowEstimate !== undefined && !isNonNegative(table.rowEstimate)) throw invalid(label + ' rowEstimate');
  const { indexes } = table;
  if (indexes !== undefined && !Array.isArray(indexes)) throw invalid(label + ' indexes');
  if (Array.isArray(indexes)) for (const index of indexes) validateIndex(index, label);
  if (table.foreignKeys !== undefined && !Array.isArray(table.foreignKeys)) throw invalid(label + ' foreignKeys');
}

// The assertion signature carries the checked shape; the checks cover only what the rules read.
function assertSnapshotShape(snapshot: unknown): asserts snapshot is SchemaSnapshot {
  if (!isPlainObject(snapshot)) throw invalid('expected a JSON object');
  if (snapshot.version !== supportedVersion) {
    throw new Error(`Unsupported schema snapshot version; this tool reads version ${supportedVersion}.`);
  }
  if (typeof snapshot.dialect !== 'string' || !dialects.has(snapshot.dialect))
    throw invalid('dialect must be postgres, mysql or mongo');
  if (snapshot.capturedAt !== undefined && typeof snapshot.capturedAt !== 'string') throw invalid('capturedAt');
  if (snapshot.statsAgeDays !== undefined && !isNonNegative(snapshot.statsAgeDays)) throw invalid('statsAgeDays');
  validateRoundTrip(snapshot.roundTrip);
  if (!isPlainObject(snapshot.tables)) throw invalid('tables');
  for (const [name, table] of Object.entries(snapshot.tables)) validateTable(name, table);
  // The checks above cover what the rules read; the file's remaining fields are informational.
}

function validateSnapshot(snapshot: unknown): SchemaSnapshot {
  assertSnapshotShape(snapshot);
  return snapshot;
}

function loadSnapshot(filename: string): SchemaSnapshot {
  const raw = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(raw);
  } catch {
    throw invalid('the file is not valid JSON');
  }
  return validateSnapshot(snapshot);
}

function useSnapshot(snapshot: SchemaSnapshot | undefined): void {
  activeSnapshot = snapshot;
  resetProjectRootCache();
}

function currentSnapshot(): SchemaSnapshot | undefined {
  return activeSnapshot;
}

function realDirectory(directory: string): string {
  try {
    return fs.realpathSync.native(directory);
  } catch {
    return path.resolve(directory);
  }
}

// Rules ask for the project of every source file, so the answers are shared for the length of one
// scan. Each folder maps to the nearest package.json folder at or above it, or to undefined when
// the walk ends at the temp folder.
const projectRootByDirectory = new Map<string, string | undefined>();
let temporaryDirectory: string | undefined;

function resetProjectRootCache(): void {
  projectRootByDirectory.clear();
  temporaryDirectory = undefined;
}

// The real path, because Windows can report the temp folder by its 8.3 short name
// (C:\Users\ABCDEF~1\...).
function realTemporaryDirectory(): string {
  temporaryDirectory ??= realDirectory(os.tmpdir());
  return temporaryDirectory;
}

function nearestProjectRoot(directory: string): string | undefined {
  const visited: string[] = [];
  let root: string | undefined;
  for (let candidate = directory; ; candidate = path.dirname(candidate)) {
    if (projectRootByDirectory.has(candidate)) {
      root = projectRootByDirectory.get(candidate);
      break;
    }
    visited.push(candidate);
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      root = candidate;
      break;
    }
    // A package.json above the temp folder (such as in the home folder) must not make every sibling
    // temp project part of this one.
    if (realDirectory(candidate) === realTemporaryDirectory() || path.dirname(candidate) === candidate) break;
  }
  for (const candidate of visited) projectRootByDirectory.set(candidate, root);
  return root;
}

// The nearest package.json marks the project whose schema files and drivers belong to the scanned
// code.
function findProjectRoot(start: string): string {
  let directory = path.resolve(start);
  if (fs.statSync(directory, { throwIfNoEntry: false })?.isFile()) directory = path.dirname(directory);
  return nearestProjectRoot(directory) ?? directory;
}

export { loadSnapshot, validateSnapshot, useSnapshot, currentSnapshot, findProjectRoot };
