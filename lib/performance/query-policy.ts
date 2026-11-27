import fs from 'node:fs';
import type { ScopePolicy } from '../shared/types.js';
import type { PerformancePolicy } from './types/performance-policy.js';
import { validateParallelReads } from './parallel-reads-policy.js';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MODULE_NAME = /^(?:#|@(?:[\w-][\w.-]*)?\/)?[\w-][\w.-]*(?:\/[\w-][\w.-]*)*$/;

function stableModuleName(value: unknown): value is string {
  return typeof value === 'string' && MODULE_NAME.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectDuplicateKeys(contents: string, label = 'query policy key') {
  // JSON.parse already checked syntax. Walk only strings and object boundaries
  // because it otherwise silently discards the first declaration of a scope.
  const objects: Set<string>[] = [];
  for (const token of contents.matchAll(/("(?:\\.|[^"\\])*")\s*(:)?|[{}]/g)) {
    if (token[0] === '{') objects.push(new Set());
    else if (token[0] === '}') objects.pop();
    else if (token[2]) {
      const names = objects.at(-1);
      if (!names) continue;
      const key: string = JSON.parse(token[1]);
      if (names.has(key)) throw new TypeError(`Duplicate ${label} at character ${(token.index ?? 0) + 1}.`);
      names.add(key);
    }
  }
}

function loadQueryPolicy(filename: string): PerformancePolicy {
  const contents = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
  let policy: unknown;
  try {
    policy = JSON.parse(contents);
  } catch {
    throw new TypeError('Query policy file contains invalid JSON.');
  }
  rejectDuplicateKeys(contents);
  return validateQueryPolicy(policy);
}

function isNameList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((name) => typeof name === 'string' && NAME.test(name));
}

// Also validates the "performance" section of loadwise.config.json, which holds the same policy.
function validateQueryPolicy(policy: unknown): PerformancePolicy {
  if (
    !record(policy) ||
    !Object.keys(policy).length ||
    Object.keys(policy).some(
      (key) => !['prismaScopes', 'drizzleScopes', 'parallelReads', 'fireAndForget'].includes(key),
    )
  ) {
    throw new TypeError(
      'Expected a query policy containing prismaScopes, drizzleScopes, parallelReads or fireAndForget.',
    );
  }
  const validated: PerformancePolicy = {};
  for (const section of ['prismaScopes', 'drizzleScopes'] as const) {
    if (!(section in policy)) continue;
    const scopes = policy[section];
    if (!record(scopes) || !Object.keys(scopes).length)
      throw new TypeError('Expected a nonempty ' + section + ' policy.');
    const drizzle = section === 'drizzleScopes';
    const checkedScopes: Record<string, ScopePolicy> = {};
    for (const [name, scope] of Object.entries(scopes)) {
      if (
        !NAME.test(name) ||
        !record(scope) ||
        Object.keys(scope).sort().join(',') !== (drizzle ? 'export,field,from,tableFrom' : 'export,field,from') ||
        typeof scope.field !== 'string' ||
        !scope.field.length ||
        scope.field === '__proto__' ||
        (!drizzle && !NAME.test(scope.field)) ||
        typeof scope.export !== 'string' ||
        !NAME.test(scope.export) ||
        !stableModuleName(scope.from) ||
        (drizzle && !stableModuleName(scope.tableFrom))
      ) {
        throw new TypeError('Invalid ' + section + ' entry. Supply literal names and stable module specifiers.');
      }
      if (!drizzle && ['AND', 'OR', 'NOT'].includes(scope.field)) {
        throw new TypeError(
          'Prisma exposes AND, OR and NOT as logical filters. Choose a distinct Prisma scalar field name and use @map to preserve the database column name.',
        );
      }
      checkedScopes[name] = { ...scope, field: scope.field };
    }
    validated[section] = checkedScopes;
  }
  if ('fireAndForget' in policy) {
    const names = policy.fireAndForget;
    if (!isNameList(names)) throw new TypeError('fireAndForget requires a nonempty array of function or method names.');
    validated.fireAndForget = names;
  }
  if ('parallelReads' in policy) {
    validated.parallelReads = validateParallelReads(policy.parallelReads);
  }
  return validated;
}

export { loadQueryPolicy, rejectDuplicateKeys, validateQueryPolicy };
