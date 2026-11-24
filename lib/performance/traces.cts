import { createHash } from 'node:crypto';
import { DuplicateReads, text as stringAttribute } from './cache-reads.cjs';
import { SpanTiming } from './span-timing.cjs';
import type { Finding } from '../shared/types.cjs';
import type { OtlpAttributes, OtlpValue } from './types/otlp-attributes.cjs';
import type { OtlpRecord, OtlpSpan, RepeatedSpanGroup, TraceState } from './types/otlp-trace.cjs';

interface TraceInspection {
  scannedSpans: number;
  eligibleDbSpans: number;
  findings: Finding[];
}

const DEFAULT_THRESHOLD = 5;
const CLIENT_KIND = 3;
const MAX_CACHED_SIGNATURES = 128;
const MAX_CACHED_CHARACTERS = 2048;
const TRACE_ID = /^[a-f\d]{32}$/i;
const SPAN_ID = /^[a-f\d]{16}$/i;
const ZERO_ID = /^0+$/;
const ROOT_PARENT_ID = '0'.repeat(16);
const DISPLAY_SYSTEMS = new Set([
  'aws.dynamodb',
  'dynamodb',
  'cassandra',
  'clickhouse',
  'cockroachdb',
  'couchbase',
  'couchdb',
  'elasticsearch',
  'mariadb',
  'microsoft.sql_server',
  'mongodb',
  'mssql',
  'mysql',
  'neo4j',
  'opensearch',
  'oracle',
  'postgresql',
  'redis',
  'sqlite',
  'valkey',
]);

function isRecord(value: unknown): value is OtlpRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function records(value: unknown, field: string): OtlpRecord[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new TypeError(`Expected an OTLP array of objects at ${field}.`);
  }
  return value;
}

const MAX_ATTRIBUTE_DEPTH = 64;

function validAttributeValue(value: unknown, depth = 0): value is OtlpValue {
  if (depth > MAX_ATTRIBUTE_DEPTH || !isRecord(value)) return false;
  const fields = Object.keys(value);
  if (!fields.length) return true; // Unset OTLP AnyValue.
  if (fields.length !== 1) return false;
  const [field] = fields;
  const content = value[field];
  switch (field) {
    case 'stringValue':
    case 'bytesValue':
      return typeof content === 'string';
    case 'boolValue':
      return typeof content === 'boolean';
    case 'stringValueStrindex':
      return Number.isInteger(content);
    case 'intValue':
      return Number.isSafeInteger(content) || (typeof content === 'string' && /^-?\d+$/.test(content));
    case 'doubleValue':
      return (
        typeof content === 'number' ||
        (typeof content === 'string' && ['NaN', 'Infinity', '-Infinity'].includes(content))
      );
    case 'arrayValue':
      return (
        isRecord(content) &&
        (content.values === undefined ||
          (Array.isArray(content.values) &&
            content.values.every((entry: unknown) => validAttributeValue(entry, depth + 1))))
      );
    case 'kvlistValue':
      return (
        isRecord(content) &&
        (content.values === undefined ||
          (Array.isArray(content.values) &&
            content.values.every(
              (entry: unknown) =>
                isRecord(entry) && typeof entry.key === 'string' && validAttributeValue(entry.value, depth + 1),
            )))
      );
    default:
      return false;
  }
}

function readAttributes(list: unknown = [], field: string): Map<string, OtlpValue> {
  const attributes = new Map<string, OtlpValue>();
  if (!Array.isArray(list)) throw new TypeError(`Expected an OTLP array of objects at ${field}.`);
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.key !== 'string' || !entry.key || !validAttributeValue(entry.value)) {
      throw new TypeError(`Invalid OTLP attribute at ${field}.`);
    }
    attributes.set(entry.key, entry.value);
  }
  if (attributes.size !== list.length) throw new TypeError(`Duplicate OTLP attribute at ${field}.`);
  return attributes;
}

function spanAttributes(list: unknown = [], state: TraceState): Map<string, OtlpValue> | undefined {
  // Exporters often repeat the same non-database attribute keys for most spans.
  // A previously validated layout has unique keys; still validate every new value.
  const keys = state.nonDatabaseKeys;
  if (keys && Array.isArray(list) && keys.length === list.length) {
    let index = 0;
    for (; index < keys.length; index++) {
      const entry = list[index];
      if (!isRecord(entry) || entry.key !== keys[index]) break;
      if (!validAttributeValue(entry.value)) throw new TypeError('Invalid OTLP attribute at span.attributes.');
    }
    if (index === keys.length) return;
  }
  const attributes = readAttributes(list, 'span.attributes');
  if (attributes.has('db.system.name') || attributes.has('db.system') || attributes.has('rpc.service'))
    return attributes;
  state.nonDatabaseKeys = Array.from(attributes.keys());
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function resourceIdentity(resource: unknown): string {
  if (resource !== undefined && !isRecord(resource)) throw new TypeError('Invalid OTLP resource.');
  const attributes = readAttributes(isRecord(resource) ? resource.attributes : undefined, 'resource.attributes');
  const ordered = [...attributes.keys()].sort().map((key) => [key, attributes.get(key)]);
  return digest(JSON.stringify(ordered));
}

function id(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== 'string' || !pattern.test(value) || ZERO_ID.test(value)) {
    throw new TypeError(`Invalid OTLP ${field}.`);
  }
  return value.toLowerCase();
}

function operationIdentity(attributes: OtlpAttributes, system: string, spanName?: unknown): string[] | null {
  const text = stringAttribute(attributes, 'db.query.text', 'db.statement');
  const summary = stringAttribute(attributes, 'db.query.summary').trim();
  const operation = stringAttribute(attributes, 'db.operation.name', 'db.operation');
  const collection = stringAttribute(
    attributes,
    'db.collection.name',
    'db.mongodb.collection',
    'db.sql.table',
    'db.cassandra.table',
  );
  if (text) return ['statement', text.trim(), operation, collection];
  if (summary && (/\s/u.test(summary) || collection)) return ['summary', summary, operation, collection];
  if (operation && collection) return ['collection', operation, collection];
  if (system === 'aws.dynamodb' || system === 'dynamodb') {
    const method = operation || stringAttribute(attributes, 'rpc.method') || spanName;
    const tables = attributes.get('aws.dynamodb.table_names')?.arrayValue?.values;
    if (typeof method === 'string' && /^(?:DynamoDB[./])?GetItem$/i.test(method)) {
      const table = collection || (tables?.length === 1 && tables[0]?.stringValue);
      if (table) return ['collection', 'GetItem', table];
    }
  }
  const namespace = stringAttribute(attributes, 'db.namespace', 'db.name');
  if (
    namespace &&
    ((system === 'mongodb' && /^(?:find|findOne)$/i.test(operation)) ||
      ((system === 'aws.dynamodb' || system === 'dynamodb') && /^GetItem$/i.test(operation)))
  ) {
    return ['namespace-read', operation.toLowerCase()];
  }
  return null;
}

function redisCommand(attributes: OtlpAttributes, spanName: unknown): string {
  const operation = stringAttribute(attributes, 'db.operation.name', 'db.operation');
  const text = stringAttribute(attributes, 'db.query.text', 'db.statement');
  const command = operation || text;
  if (command) {
    if (/[\r\n]/.test(command)) return '';
    return /^\s*([a-z]+)(?:\s|$)/i.exec(command)?.[1].toUpperCase() || '';
  }
  const summary = stringAttribute(attributes, 'db.query.summary');
  const name = summary || (typeof spanName === 'string' ? spanName : '');
  return (
    /^(?:(?:redis|valkey)[-.])?(GET|HGET|KEYS|MULTI|BATCH|PIPELINE|MGET|HMGET|[HSZ]?SCAN)(?:\s+\d+)?$/i
      .exec(name.trim())?.[1]
      .toUpperCase() || ''
  );
}

const BATCH_COMMANDS = new Set(['PIPELINE', 'MULTI', 'BATCH']);
const BULK_OR_CURSOR_COMMANDS = new Set(['MGET', 'HMGET', 'SCAN', 'HSCAN', 'SSCAN', 'ZSCAN']);

function redisOperation(command: string, attributes: OtlpAttributes, system: string): string[] | null {
  if (command === 'KEYS') return ['redis-keys-scan', command];
  if (command === 'GET' || command === 'HGET') return ['redis-repeated-read', command];
  if (BULK_OR_CURSOR_COMMANDS.has(command)) return null;
  return operationIdentity(attributes, system);
}

function databaseIdentity(attributes: OtlpAttributes, system: string): (string | string[] | null)[] {
  const port = attributes.get('server.port') ?? attributes.get('net.peer.port');
  return [
    system,
    stringAttribute(attributes, 'db.namespace', 'db.name', 'db.cassandra.keyspace') ||
      String(attributes.get('db.redis.database_index')?.intValue ?? ''),
    stringAttribute(attributes, 'server.address', 'net.peer.name', 'net.peer.ip', 'network.peer.address'),
    String(port?.intValue ?? port?.stringValue ?? ''),
    stringAttribute(attributes, 'db.connection_string'),
    system === 'aws.dynamodb' || system === 'dynamodb'
      ? [stringAttribute(attributes, 'cloud.region'), stringAttribute(attributes, 'cloud.account.id')]
      : null,
  ];
}

function signatureFingerprint(signature: string, cache: Map<string, string>): string {
  const cached = cache.get(signature);
  if (cached) return cached;
  const fingerprint = digest(signature);
  if (signature.length <= MAX_CACHED_CHARACTERS) {
    if (cache.size === MAX_CACHED_SIGNATURES) cache.clear();
    cache.set(signature, fingerprint);
  }
  return fingerprint;
}

// Checks the members the grouping relies on; the validated shape is what `span` has afterwards.
function assertSpanShape(span: OtlpRecord): asserts span is OtlpRecord & OtlpSpan {
  const { kind, status } = span;
  if (kind !== undefined && (typeof kind !== 'number' || !Number.isInteger(kind) || kind < 0 || kind > 5)) {
    throw new TypeError('Invalid OTLP numeric span kind.');
  }
  if (
    status !== undefined &&
    (!isRecord(status) ||
      (status.code !== undefined &&
        (typeof status.code !== 'number' || !Number.isInteger(status.code) || status.code < 0 || status.code > 2)))
  ) {
    throw new TypeError('Invalid OTLP span status.');
  }
}

function addSpan(span: OtlpRecord, resource: string, state: TraceState): void {
  const { seen, groups, signatures, batchParents, duplicateReads } = state;
  if (!state.lastTraceId || span.traceId !== state.lastTraceId)
    state.lastTraceId = id(span.traceId, TRACE_ID, 'traceId');
  const traceId = state.lastTraceId;
  const spanId = id(span.spanId, SPAN_ID, 'spanId');
  const parent = span.parentSpanId;
  let parentSpanId = '';
  if (parent !== undefined && parent !== '' && parent !== ROOT_PARENT_ID) {
    if (!state.lastParentId || parent !== state.lastParentId) state.lastParentId = id(parent, SPAN_ID, 'parentSpanId');
    parentSpanId = state.lastParentId;
  }
  const attributes = spanAttributes(span.attributes, state);
  assertSpanShape(span);
  if (!attributes) return;
  let system = stringAttribute(attributes, 'db.system.name', 'db.system');
  if (
    !system &&
    stringAttribute(attributes, 'rpc.service') === 'DynamoDB' &&
    stringAttribute(attributes, 'rpc.system.name', 'rpc.system') === 'aws-api'
  )
    system = 'aws.dynamodb';
  if (!system) return;
  const isRedis = system === 'redis' || system === 'valkey';
  const command = isRedis ? redisCommand(attributes, span.name) : '';
  const isRedisBatch =
    isRedis &&
    (BATCH_COMMANDS.has(command) ||
      attributes.has('db.redis.pipeline_length') ||
      attributes.has('db.operation.batch.size'));
  const fingerprint = duplicateReads.observe(traceId, span, attributes, system, command, isRedisBatch);
  if (isRedisBatch) {
    batchParents.add(resource + traceId + spanId);
    return;
  }
  if ((span.kind && span.kind !== CLIENT_KIND) || (!parentSpanId && command !== 'KEYS')) return;
  const operation = isRedis
    ? redisOperation(command, attributes, system)
    : operationIdentity(attributes, system, span.name);
  if (!operation) return;
  const identity = traceId + spanId;
  if (seen.has(identity)) return;
  seen.add(identity);

  const signature = JSON.stringify([resource, databaseIdentity(attributes, system), operation]);
  const key = traceId + parentSpanId + signatureFingerprint(signature, signatures);
  const existing = groups.get(key);
  if (existing) {
    existing.count++;
    existing.timing.add(span);
  } else {
    const timing = new SpanTiming();
    timing.add(span);
    const [signatureKind] = operation;
    const isRead = signatureKind === 'redis-repeated-read';
    const ruleId = isRead || signatureKind === 'redis-keys-scan' ? signatureKind : 'repeated-db-span';
    groups.set(key, {
      ruleId,
      traceId,
      parentSpanId,
      exampleSpanId: spanId,
      system: DISPLAY_SYSTEMS.has(system) ? system : 'other',
      count: 1,
      batchParent: isRead ? resource + traceId + parentSpanId : null,
      signatureKind,
      readCommand: isRead ? command : '',
      timing,
    });
  }
  const group = groups.get(key);
  if (fingerprint && group) duplicateReads.record(fingerprint, key, group, spanId, span);
}

function groupMessage(
  group: Pick<RepeatedSpanGroup, 'ruleId' | 'count'>,
  signatureKind: string,
  readCommand: string,
): string {
  if (group.ruleId === 'redis-keys-scan') {
    return 'KEYS walks the whole keyspace in one command and blocks Redis while it runs. Iterate with `scanIterator({ MATCH, COUNT })` (`scanStream` in ioredis) instead; results may repeat or change during iteration.';
  }
  if (group.ruleId === 'redis-repeated-read') {
    const alternative = readCommand === 'GET' ? '`mGet(keys)`' : '`hmGet(key, fields)` for fields of one hash';
    return `${group.count} sibling ${readCommand} operations each cost a network round trip. Use ${alternative} or one pipeline; check ordering, error handling and cluster slots.`;
  }
  if (signatureKind === 'namespace-read') {
    return `${group.count} sibling reads ran the same operation in one namespace, one round trip each. Combine them into one query, for example with an $in or IN (...) filter, if their predicates allow it.`;
  }
  return `${group.count} sibling database calls share one operation signature, one round trip each. Batch them into one statement such as WHERE id = ANY($1), or reuse a shared result, if behavior allows it.`;
}

function inspectTraces(
  document: unknown,
  { threshold = DEFAULT_THRESHOLD }: { threshold?: number } = {},
): TraceInspection {
  if (!Number.isSafeInteger(threshold) || threshold < 2)
    throw new RangeError('Trace threshold must be an integer of at least 2.');
  if (!isRecord(document)) throw new TypeError('Expected an OTLP export object containing resourceSpans.');
  const groups = new Map<string, RepeatedSpanGroup>();
  const seen = new Set<string>();
  const signatures = new Map<string, string>();
  const batchParents = new Set<string>();
  const duplicateReads = new DuplicateReads();
  const state: TraceState = { seen, groups, signatures, batchParents, duplicateReads };
  let scannedSpans = 0;
  for (const batch of records(document.resourceSpans, 'resourceSpans')) {
    const resource = resourceIdentity(batch.resource);
    for (const scope of records(batch.scopeSpans, 'scopeSpans')) {
      const spans = records(scope.spans, 'spans');
      scannedSpans += spans.length;
      for (const span of spans) addSpan(span, resource, state);
    }
  }
  let eligibleDbSpans = seen.size;
  const { findings, coveredGroups } = duplicateReads.results();
  for (const storedGroup of groups.values()) {
    if (coveredGroups.has(storedGroup)) continue;
    const { batchParent, signatureKind, readCommand, timing, ...group } = storedGroup;
    if (batchParent && batchParents.has(batchParent)) {
      eligibleDbSpans -= group.count;
      continue;
    }
    if (group.count >= threshold || group.ruleId === 'redis-keys-scan') {
      const finding: Finding = { ...group, message: groupMessage(group, signatureKind, readCommand) };
      const impact = group.ruleId === 'redis-keys-scan' ? undefined : timing.impact();
      if (impact) finding.impact = impact;
      findings.push(finding);
    }
  }
  return { scannedSpans, eligibleDbSpans, findings };
}

export { inspectTraces };
