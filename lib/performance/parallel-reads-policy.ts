import type { ParallelReadGroup, ParallelReadGroups } from './types/parallel-reads.js';

const MODULE_NAME = /^(?:#|@(?:[\w-][\w.-]*)?\/)?[\w-][\w.-]*(?:\/[\w-][\w.-]*)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStableModuleName(value: unknown): value is string {
  return typeof value === 'string' && MODULE_NAME.test(value);
}

function validateParallelReads(raw: unknown): ParallelReadGroups {
  if (!Array.isArray(raw) || !raw.length) throw new Error('parallelReads requires a nonempty array of read groups.');
  const modules: ParallelReadGroups = new Map();
  const entries: readonly unknown[] = raw;
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join(',') !== 'exports,from' ||
      !isStableModuleName(entry.from) ||
      !Array.isArray(entry.exports) ||
      entry.exports.length < 2 ||
      new Set(entry.exports).size !== entry.exports.length ||
      !Array.from(entry.exports).every((name) => typeof name === 'string' && /^[A-Za-z_$][\w$]*$/.test(name))
    ) {
      throw new Error(
        'Each parallelReads group requires a stable module name and at least two distinct named exports.',
      );
    }
    const exportedNames: string[] = entry.exports;
    const group: ParallelReadGroup = { from: entry.from, exports: exportedNames };
    let exports = modules.get(group.from);
    if (!exports) {
      exports = new Map<string, Set<ParallelReadGroup>>();
      modules.set(group.from, exports);
    }
    for (const name of exportedNames) {
      let groupsOfName = exports.get(name);
      if (!groupsOfName) {
        groupsOfName = new Set<ParallelReadGroup>();
        exports.set(name, groupsOfName);
      }
      groupsOfName.add(group);
    }
  }
  return modules;
}

export { validateParallelReads };
