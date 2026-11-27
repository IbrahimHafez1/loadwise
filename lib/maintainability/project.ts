import fs from 'node:fs';
import path from 'node:path';
import { checkPlacement } from './layout.js';
import { checkGraph } from './graph.js';
import { validateDataAccess } from './data-access.js';
import { defaultLimits } from './limits.js';
import type { FolderBoundary, ModuleEdge } from './types/module-graph.js';
import type { MaintainabilityPolicy, PlacementRule, SizeLimits } from './types/policy.js';
import type { GraphScan } from './types/scan-report.js';

// The policy and graph files as written, before validation.
interface RawPolicyConfig {
  exclude?: unknown[];
  boundaries?: unknown[];
  placement?: PlacementRule[];
  dataAccess?: unknown;
  limits?: unknown;
  [key: string]: unknown;
}

interface RawBoundary {
  from?: unknown;
  disallow?: unknown;
}

interface RawGraph {
  files?: unknown;
  edges?: unknown;
}

interface RawGraphEdge {
  from?: unknown;
  to?: unknown;
  line?: unknown;
  column?: unknown;
  kind?: unknown;
}

function objectWithKeys<Shape extends object>(
  value: unknown,
  allowed: readonly string[],
  name: string,
): asserts value is Shape {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    throw new Error('Invalid ' + name + '. Allowed keys: ' + allowed.join(', '));
  }
}

function relativeName(value: unknown, allowRoot = false): string {
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

function readJson(filename: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Invalid JSON in ' + filename);
    throw error;
  }
}

function validateLimits(limits: unknown = {}): SizeLimits {
  objectWithKeys<Partial<Record<string, unknown>>>(limits, Object.keys(defaultLimits), 'limits');
  for (const [name, value] of Object.entries(limits)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
      throw new Error('Limit ' + name + ' must be a positive integer.');
  }
  return { ...defaultLimits, ...limits };
}

// The explicit --config file wins, then the "maintainability" section of loadwise.config.json.
function loadPolicy(explicit?: string, configSection?: unknown): MaintainabilityPolicy {
  if (explicit) return policyFromConfig(readJson(path.resolve(explicit)));
  return policyFromConfig(configSection ?? {});
}

function policyFromConfig(config: unknown): MaintainabilityPolicy {
  objectWithKeys<RawPolicyConfig>(
    config,
    ['exclude', 'boundaries', 'placement', 'dataAccess', 'limits'],
    'maintainability config',
  );
  for (const key of ['exclude', 'boundaries', 'placement']) {
    if (Object.hasOwn(config, key) && !Array.isArray(config[key])) throw new Error(key + ' must be an array.');
  }
  const exclude = (config.exclude ?? []).map((name) => relativeName(name));
  const boundaries = (config.boundaries ?? []).map((boundary): FolderBoundary => {
    objectWithKeys<RawBoundary>(boundary, ['from', 'disallow'], 'boundary');
    if (!Array.isArray(boundary.disallow) || !boundary.disallow.length)
      throw new Error('A boundary needs disallow folders.');
    return {
      from: relativeName(boundary.from, true),
      disallow: boundary.disallow.map((name: unknown) => relativeName(name, true)),
    };
  });
  const placement = config.placement ?? [];
  for (const rule of placement) objectWithKeys<PlacementRule>(rule, ['suffix', 'under'], 'placement rule');
  checkPlacement([], placement);
  const dataAccess = Object.hasOwn(config, 'dataAccess')
    ? validateDataAccess(config.dataAccess, relativeName)
    : undefined;
  return { exclude, boundaries, placement, dataAccess, limits: validateLimits(config.limits) };
}

function checkImportedGraph(filename: string, policy: MaintainabilityPolicy): GraphScan {
  const graph = readJson(filename);
  objectWithKeys<RawGraph>(graph, ['files', 'edges'], 'module graph');
  if (!Array.isArray(graph.files) || !Array.isArray(graph.edges))
    throw new Error('Graph requires files and edges arrays.');
  const files = graph.files.map((file: unknown) => relativeName(file));
  const known = new Set(files);
  if (known.size !== files.length) throw new Error('Duplicate graph file.');
  const edges = graph.edges.map((edge: unknown): ModuleEdge => {
    objectWithKeys<RawGraphEdge>(edge, ['from', 'to', 'line', 'column', 'kind'], 'graph edge');
    const from = relativeName(edge.from),
      to = relativeName(edge.to);
    if (!known.has(from) || !known.has(to)) throw new Error('Graph edge endpoint missing from files.');
    const { kind, line, column } = edge;
    if (kind !== undefined && kind !== 'eager' && kind !== 'deferred') throw new Error('Invalid graph edge kind.');
    if (
      typeof line !== 'number' ||
      typeof column !== 'number' ||
      ![line, column].every((position) => Number.isSafeInteger(position) && position > 0)
    ) {
      throw new Error('Graph edges need one-based line and column numbers.');
    }
    return { from, to, line, column, ...(kind !== undefined && { kind }) };
  });
  const included = files.filter(
    (file) => !policy.exclude.some((name) => file === name || file.startsWith(name + '/')) && !policy.isIgnored?.(file),
  );
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

export { loadPolicy, checkImportedGraph, relativeName };
