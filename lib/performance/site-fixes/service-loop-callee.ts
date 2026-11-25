// Callee analysis: which client family a finding is about and which helper declaration holds the
// per-item query.
import { innermostNodeAt } from '../../shared/fix-hunks.js';
import { ts, textOf } from './helpers.js';
import type { Node } from 'typescript';
import type { RelatedLocation } from '../types/related-location.js';
import type { ClientFamily } from '../types/client-family.js';
import type { HelperFunction } from '../types/helper-function.js';
import type { CalleeHelper } from '../types/callee-helper.js';
import type { Finding, SiteFixInput } from '../../shared/types.js';

export function clientFamily(message: string): ClientFamily | undefined {
  if (message.includes('`In(ids)`')) return 'typeorm';
  if (message.includes('`{ in: ids }`')) return 'prisma';
}

function isHelperFunction(node: Node): node is HelperFunction {
  return (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && !!node.body && !!node.name;
}

function enclosingNamedFunction(node: Node): HelperFunction | undefined {
  for (let current: Node = node; current; current = current.parent) if (isHelperFunction(current)) return current;
}

// The related locations of a finding, or undefined when it has none or one is not a location.
export function relatedLocations(finding: Finding): readonly RelatedLocation[] | undefined {
  const { related } = finding;
  if (!Array.isArray(related)) return;
  const entries: readonly unknown[] = related;
  return entries.every(isRelatedLocation) ? entries : undefined;
}

function isRelatedLocation(value: unknown): value is RelatedLocation {
  return (
    typeof value === 'object' &&
    value !== null &&
    'file' in value &&
    typeof value.file === 'string' &&
    'line' in value &&
    typeof value.line === 'number' &&
    'column' in value &&
    typeof value.column === 'number'
  );
}

// The helper declaration when every listed query sits directly in it, so its body is the whole
// story.
export function directCallee(
  related: readonly RelatedLocation[] | undefined,
  name: string,
  load: SiteFixInput['load'],
): CalleeHelper | undefined {
  if (!related?.length) return;
  let found: CalleeHelper | undefined;
  for (const location of related) {
    const entry = load(location.file);
    if (!entry?.sourceFile) return;
    const offset = entry.lineStarts[location.line - 1] + location.column - 1;
    const token = innermostNodeAt(ts, entry.sourceFile, offset);
    const declaration = token && enclosingNamedFunction(token);
    if (!declaration || textOf(declaration.name) !== name) return;
    if (found && found.declaration !== declaration) return;
    found = { entry: { ...entry, sourceFile: entry.sourceFile }, declaration };
  }
  return found;
}
