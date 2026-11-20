'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { checkPlacement } = require('./layout.cjs');
const { checkGraph } = require('./graph.cjs');
const { validateDataAccess } = require('./data-access.cjs');
const { defaultLimits } = require('./limits.cjs');

function objectWithKeys(value, allowed, name) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    throw new Error('Invalid ' + name + '. Allowed keys: ' + allowed.join(', '));
  }
}

function relativeName(value, allowRoot = false) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Expected a project-relative path.');
  const normalized = value
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/(?<=.)\/$/, '');
  if (allowRoot && normalized === '.') return '.';
  if (
    /^(?:[A-Za-z]:|\/)/.test(normalized) ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Expected a project-relative path: ' + value);
  }
  return normalized;
}

function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Invalid JSON in ' + filename);
    throw error;
  }
}

function validateLimits(limits = {}) {
  objectWithKeys(limits, Object.keys(defaultLimits), 'limits');
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Limit ' + name + ' must be a positive integer.');
  }
  return { ...defaultLimits, ...limits };
}

function loadPolicy(root, explicit) {
  const filename = explicit ? path.resolve(explicit) : path.join(root, 'maintainability.config.json');
  const config = !explicit && !fs.existsSync(filename) ? {} : readJson(filename);
  objectWithKeys(config, ['exclude', 'boundaries', 'placement', 'dataAccess', 'limits'], 'maintainability config');
  for (const key of ['exclude', 'boundaries', 'placement']) {
    if (Object.hasOwn(config, key) && !Array.isArray(config[key])) throw new Error(key + ' must be an array.');
  }
  const exclude = (config.exclude ?? []).map((name) => relativeName(name));
  const boundaries = (config.boundaries ?? []).map((boundary) => {
    objectWithKeys(boundary, ['from', 'disallow'], 'boundary');
    if (!Array.isArray(boundary.disallow) || !boundary.disallow.length)
      throw new Error('A boundary needs disallow folders.');
    return {
      from: relativeName(boundary.from, true),
      disallow: boundary.disallow.map((name) => relativeName(name, true)),
    };
  });
  const placement = config.placement ?? [];
  for (const rule of placement) objectWithKeys(rule, ['suffix', 'under'], 'placement rule');
  checkPlacement([], placement);
  const dataAccess = Object.hasOwn(config, 'dataAccess')
    ? validateDataAccess(config.dataAccess, relativeName)
    : undefined;
  return { exclude, boundaries, placement, dataAccess, limits: validateLimits(config.limits) };
}

function checkImportedGraph(filename, policy) {
  const graph = readJson(filename);
  objectWithKeys(graph, ['files', 'edges'], 'module graph');
  if (!Array.isArray(graph.files) || !Array.isArray(graph.edges))
    throw new Error('Graph requires files and edges arrays.');
  const files = graph.files.map((file) => relativeName(file));
  const known = new Set(files);
  if (known.size !== files.length) throw new Error('Duplicate graph file.');
  const edges = graph.edges.map((edge) => {
    objectWithKeys(edge, ['from', 'to', 'line', 'column', 'kind'], 'graph edge');
    const from = relativeName(edge.from),
      to = relativeName(edge.to);
    if (!known.has(from) || !known.has(to)) throw new Error('Graph edge endpoint missing from files.');
    if (edge.kind !== undefined && !['eager', 'deferred'].includes(edge.kind))
      throw new Error('Invalid graph edge kind.');
    if (![edge.line, edge.column].every((position) => Number.isSafeInteger(position) && position > 0)) {
      throw new Error('Graph edges need one-based line and column numbers.');
    }
    return { ...edge, from, to };
  });
  const included = files.filter((file) => !policy.exclude.some((name) => file === name || file.startsWith(name + '/')));
  const includedSet = new Set(included);
  const retained = edges.filter((edge) => includedSet.has(edge.from) && includedSet.has(edge.to));
  return {
    mode: 'graph',
    graphFiles: included.length,
    graphEdges: retained.length,
    findings: [
      ...checkGraph({ files: included, edges: retained, boundaries: policy.boundaries }),
      ...checkPlacement(included, policy.placement),
    ],
  };
}

module.exports = { loadPolicy, checkImportedGraph, relativeName };
