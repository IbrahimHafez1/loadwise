'use strict';

const fs = require('node:fs');
const path = require('node:path');

const supportedVersion = 1;
const dialects = new Set(['postgres', 'mysql', 'mongo']);

// Rules read the snapshot inside analyzeFile, which both engines call without a CLI options channel.
let activeSnapshot;

function invalid(detail) {
  // The snapshot path may be user-chosen, but its contents are never echoed so stray data cannot leak.
  return new Error('Invalid schema snapshot: ' + detail + '.');
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateRoundTrip(roundTrip) {
  if (roundTrip === undefined) return;
  if (!isPlainObject(roundTrip) || !isNonNegative(roundTrip.medianMs)) throw invalid('roundTrip.medianMs');
  if (!Number.isSafeInteger(roundTrip.runs) || roundTrip.runs < 1) throw invalid('roundTrip.runs');
  if (roundTrip.kind !== 'measured') throw invalid('roundTrip.kind');
}

function validateIndex(index, label) {
  if (!isPlainObject(index) || !Array.isArray(index.keys) || !index.keys.every(isPlainObject)) {
    throw invalid(label + ' keys');
  }
}

function validateTable(name, table) {
  const label = 'table ' + JSON.stringify(name);
  if (!isPlainObject(table)) throw invalid(label);
  if (table.rowEstimate !== undefined && !isNonNegative(table.rowEstimate)) throw invalid(label + ' rowEstimate');
  if (table.indexes !== undefined && !Array.isArray(table.indexes)) throw invalid(label + ' indexes');
  for (const index of table.indexes ?? []) validateIndex(index, label);
  if (table.foreignKeys !== undefined && !Array.isArray(table.foreignKeys)) throw invalid(label + ' foreignKeys');
}

function validateSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) throw invalid('expected a JSON object');
  if (snapshot.version !== supportedVersion) {
    throw new Error(`Unsupported schema snapshot version; this tool reads version ${supportedVersion}.`);
  }
  if (!dialects.has(snapshot.dialect)) throw invalid('dialect must be postgres, mysql or mongo');
  if (snapshot.capturedAt !== undefined && typeof snapshot.capturedAt !== 'string') throw invalid('capturedAt');
  if (snapshot.statsAgeDays !== undefined && !isNonNegative(snapshot.statsAgeDays)) throw invalid('statsAgeDays');
  validateRoundTrip(snapshot.roundTrip);
  if (!isPlainObject(snapshot.tables)) throw invalid('tables');
  for (const [name, table] of Object.entries(snapshot.tables)) validateTable(name, table);
  return snapshot;
}

function loadSnapshot(filename) {
  const raw = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch {
    throw invalid('the file is not valid JSON');
  }
  return validateSnapshot(snapshot);
}

function useSnapshot(snapshot) {
  activeSnapshot = snapshot;
}

function currentSnapshot() {
  return activeSnapshot;
}

// The nearest package.json marks the project whose schema files and drivers belong to the scanned code.
function findProjectRoot(start) {
  let directory = path.resolve(start);
  if (fs.statSync(directory, { throwIfNoEntry: false })?.isFile()) directory = path.dirname(directory);
  for (let candidate = directory; ; candidate = path.dirname(candidate)) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(candidate) === candidate) return directory;
  }
}

module.exports = { loadSnapshot, validateSnapshot, useSnapshot, currentSnapshot, findProjectRoot };
