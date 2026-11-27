import { createHash } from 'node:crypto';
import { SpanTiming } from './span-timing.js';
import type { Finding } from '../shared/types.js';
import type { DuplicateReadGroup, OtlpAttributes, OtlpObservedSpan, OtlpValue } from './types/otlp-attributes.js';

/** The single-row lookup of a read: the kind of its key and the key. */
type LookupValue = [kind: string, value: string];

interface DuplicateCandidate {
  group: DuplicateReadGroup;
  exampleSpanId: string;
  count: number;
  timing: SpanTiming;
}

const SQL_SYSTEMS = new Set(['postgresql', 'mysql', 'mariadb', 'sqlite', 'mssql', 'microsoft.sql_server']);
const REDIS_READS = new Set(['HGET', 'HMGET', 'MGET', 'EXISTS', 'KEYS', 'SCAN', 'HSCAN', 'SSCAN', 'ZSCAN']);
const RESERVED_VALUE = /redact|mask|hidden|placeholder|obfuscat|saniti[sz]|anonymous|unknown|null|censor|\.\.\./i;
const SIMPLE_VALUE = /^[a-z0-9_:/.-]+$/i;
const IDENTIFIER = '[a-z_][a-z0-9_]*';
const SIMPLE_LOOKUP = new RegExp(
  `^\\s*select\\s+${IDENTIFIER}(?:\\s*,\\s*${IDENTIFIER})*\\s+from\\s+${IDENTIFIER}(?:\\.${IDENTIFIER})?\\s+where\\s+${IDENTIFIER}\\s*=\\s*(\\$1|\\?|%s|@[a-z_][a-z0-9_]*)\\s*;?\\s*$`,
  'i',
);
const CONTEXT_EXPRESSION =
  /\b(?:current_(?:date|time|timestamp|user|role|catalog|schema)|session_user|system_user|localtimestamp|localtime|sysdate|user)\b/i;
const BIND_PREFIX = 'db.query.parameter.';
// These canonical fields already participate in the database/operation group,
// the explicit-target check, or the independently validated lookup.
const GROUPED_FIELDS = new Set(['db.system.name', 'db.namespace', 'db.query.text', 'db.statement']);

function text(attributes: OtlpAttributes, ...keys: string[]): string {
  for (const key of keys) {
    const value = attributes.get(key)?.stringValue;
    if (value && value.trim()) return value;
  }
  return '';
}

function concrete(value: unknown): value is string {
  return typeof value === 'string' && SIMPLE_VALUE.test(value) && !RESERVED_VALUE.test(value);
}

// The recorded bind value of a lookup parameter, or null when it is redacted or missing.
function bindValue({ intValue, stringValue }: OtlpValue): LookupValue | null {
  if (intValue !== undefined) return ['int', String(intValue)];
  return concrete(stringValue) ? ['string', stringValue] : null;
}

function sqlLookup(attributes: OtlpAttributes, system: string): LookupValue | null {
  const statement = text(attributes, 'db.query.text', 'db.statement');
  const match = SIMPLE_LOOKUP.exec(statement);
  if (!match || CONTEXT_EXPRESSION.test(statement)) return null;
  const placeholder = match[1];
  const parameterName = placeholder.startsWith('@') ? placeholder.slice(1) : '0';
  if (placeholder === '$1' && system !== 'postgresql') return null;
  if (placeholder === '%s' && !['postgresql', 'mysql', 'mariadb'].includes(system)) return null;
  if (placeholder.startsWith('@') && !['mssql', 'microsoft.sql_server', 'sqlite'].includes(system)) return null;
  if (placeholder === '?' && !['mysql', 'mariadb', 'sqlite'].includes(system)) return null;
  const parameterKey = BIND_PREFIX + parameterName;
  const parameter = attributes.get(parameterKey);
  const parameterValue = parameter && bindValue(parameter);
  if (!parameterValue) return null;
  for (const key of attributes.keys()) {
    if (key.startsWith(BIND_PREFIX) && key !== parameterKey) return null;
  }
  return parameterValue;
}

function redisLookup(attributes: OtlpAttributes): LookupValue | null {
  const statement = text(attributes, 'db.query.text', 'db.statement');
  const match = /^\s*GET[ \t]+([^\s]+)\s*$/i.exec(statement);
  return match && concrete(match[1]) ? ['key', match[1]] : null;
}

function explicitTarget(attributes: OtlpAttributes, system: string): boolean {
  const redis = system === 'redis' || system === 'valkey';
  const namespace =
    text(attributes, 'db.namespace', 'db.name') ||
    (redis ? String(attributes.get('db.redis.database_index')?.intValue ?? '') : '');
  if (!knownContextString(namespace)) return false;
  if (system === 'sqlite') return /[/\\]/.test(namespace) && !/:memory:|mode=memory/i.test(namespace);
  return knownContextString(
    text(attributes, 'server.address', 'net.peer.name', 'net.peer.ip', 'network.peer.address', 'db.connection_string'),
  );
}

function knownContextString(value: string): boolean {
  return Boolean(value.trim()) && !RESERVED_VALUE.test(value) && !/(?:\*{2,}|\[filtered\]|^[?*]+$)/i.test(value);
}

function identityFingerprint(attributes: OtlpAttributes, lookup: LookupValue): string | null {
  // Application-defined context can use any name. Compare recorded scalar
  // metadata rather than guessing which keys carry identity or authorization.
  const context: [string, OtlpValue][] = [];
  for (const [key, value] of attributes) {
    if (GROUPED_FIELDS.has(key) || key.startsWith(BIND_PREFIX)) continue;
    if (value.stringValue !== undefined) {
      if (!knownContextString(value.stringValue)) return null;
    } else if (value.intValue === undefined && value.boolValue === undefined && value.doubleValue === undefined) {
      return null;
    }
    context.push([key, value]);
  }
  if (context.length > 1) context.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash('sha256')
    .update(JSON.stringify([context, lookup]))
    .digest('hex');
}

interface ObservedCall {
  readonly system: string;
  readonly command: string;
  readonly isBatch: boolean;
}

class DuplicateReads {
  blockedTraces = new Set<string>();
  candidates = new Map<string, DuplicateCandidate>();

  observe(
    traceId: string,
    span: OtlpObservedSpan,
    attributes: OtlpAttributes,
    { system, command, isBatch }: ObservedCall,
  ): string | null {
    if (this.blockedTraces.has(traceId)) return null;
    const operation = text(attributes, 'db.operation.name', 'db.operation');
    const redis = system === 'redis' || system === 'valkey';
    const forbidden =
      isBatch ||
      attributes.has('db.operation.batch.size') ||
      attributes.has('db.transaction.id') ||
      attributes.has('db.transaction_id') ||
      attributes.has('transaction.id') ||
      span.status?.code === 2 ||
      attributes.has('error.type');
    if (!forbidden) {
      if (redis && REDIS_READS.has(command)) return null;
      if (system === 'mongodb' && /^(find|findOne|getMore)$/i.test(operation)) return null;
      if ((system === 'aws.dynamodb' || system === 'dynamodb') && /^(GetItem|BatchGetItem)$/i.test(operation))
        return null;
      let lookup: LookupValue | null | undefined;
      if (redis && command === 'GET') lookup = redisLookup(attributes);
      if (SQL_SYSTEMS.has(system) && (!operation || /^SELECT$/i.test(operation)))
        lookup = sqlLookup(attributes, system);
      if (lookup && explicitTarget(attributes, system)) return identityFingerprint(attributes, lookup);
    }
    // A write with missing target metadata can invalidate any lookup in this trace.
    this.blockedTraces.add(traceId);
    return null;
  }

  record(
    fingerprint: string,
    groupKey: string,
    group: DuplicateReadGroup,
    spanId: string,
    span: OtlpObservedSpan,
  ): void {
    const key = groupKey + fingerprint;
    const candidate = this.candidates.get(key);
    if (candidate) {
      candidate.count++;
      candidate.timing.add(span);
    } else {
      const timing = new SpanTiming();
      timing.add(span);
      this.candidates.set(key, { group, exampleSpanId: spanId, count: 1, timing });
    }
  }

  results(): { findings: Finding[]; coveredGroups: Set<DuplicateReadGroup> } {
    const findings: Finding[] = [];
    const coveredGroups = new Set<DuplicateReadGroup>();
    for (const { group, count, exampleSpanId, timing } of this.candidates.values()) {
      if (count < 2 || this.blockedTraces.has(group.traceId)) continue;
      const { traceId, parentSpanId, system } = group;
      const finding: Finding = {
        ruleId: 'duplicate-key-read',
        traceId,
        parentSpanId,
        exampleSpanId,
        count,
        system,
        message: `${count} reads under one parent used the same recorded lookup and identity. Read once into a local \`const\` (or a per-request cache) and reuse it, unless freshness, ordering or authorization require separate reads.`,
      };
      const impact = timing.impact();
      if (impact) finding.impact = impact;
      findings.push(finding);
      if (count === group.count) coveredGroups.add(group);
    }
    return { findings, coveredGroups };
  }
}

export { DuplicateReads, text };
