// Looks up npm package versions in the GitHub Advisory Database through the OSV API. Only package
// names and versions leave the machine. Answers are cached for a day so a repeated run makes no
// requests.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isRecord } from '../../shared/is-record.js';
import type {
  OsvRecord,
  OsvVulnerability,
  PackageVersion,
  VulnerabilityLookupOptions,
} from '../types/osv-vulnerability.js';

const osvOrigin = 'https://api.osv.dev';
const maxBatchSize = 1000;
const detailConcurrency = 8;
const requestTimeoutMs = 30_000;
const cacheLifetimeMs = 24 * 60 * 60 * 1000;
const cacheFileName = 'osv-npm-v1.json';

function configuredOrigin() {
  const configured = process.env.LOADWISE_OSV_URL;
  if (!configured) return osvOrigin;
  const { protocol, hostname, origin } = new URL(configured);
  if (!['http:', 'https:'].includes(protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(hostname)) {
    throw new Error('LOADWISE_OSV_URL needs a local HTTP or HTTPS URL.');
  }
  return origin;
}

function defaultCacheDirectory() {
  const home = os.homedir();
  const base =
    process.platform === 'win32'
      ? (process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'))
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Caches')
        : (process.env.XDG_CACHE_HOME ?? path.join(home, '.cache'));
  return path.join(base, 'loadwise');
}

interface QueryEntry {
  at: number;
  ids: string[];
}

interface VulnerabilityEntry {
  at: number;
  vulnerability: OsvVulnerability;
}

// Answers by `name@version`, and vulnerability records by id, each stamped with when it was
// fetched.
interface OsvCache {
  queries: Record<string, QueryEntry>;
  vulnerabilities: Record<string, VulnerabilityEntry>;
}

// One package@version of a batch query; later pages of a long answer name their token.
interface OsvQuery {
  package: { name: string; ecosystem: string };
  version: string;
  page_token?: string;
}

interface OsvBatchResult {
  vulns?: { id: string }[];
  next_page_token?: string;
}

function readCache(cacheDirectory: string | undefined, now: number): OsvCache {
  const empty: OsvCache = { queries: {}, vulnerabilities: {} };
  if (!cacheDirectory) return empty;
  let cache: Partial<OsvCache> | null;
  try {
    cache = JSON.parse(fs.readFileSync(path.join(cacheDirectory, cacheFileName), 'utf8'));
  } catch {
    // A missing, corrupt or unreadable cache only costs speed: every package is looked up again.
    return empty;
  }
  if (!cache || typeof cache !== 'object') return empty;
  const isFresh = (entry: { at: number } | undefined) =>
    entry && typeof entry.at === 'number' && now - entry.at < cacheLifetimeMs;
  const freshEntries = <Entry extends { at: number }>(bucket: Record<string, Entry> | undefined) =>
    bucket && typeof bucket === 'object'
      ? Object.fromEntries(Object.entries(bucket).filter(([, entry]) => isFresh(entry)))
      : {};
  return { ...cache, queries: freshEntries(cache.queries), vulnerabilities: freshEntries(cache.vulnerabilities) };
}

// A cache that cannot be written only costs speed, so failures here must not fail the check.
function writeCache(cacheDirectory: string, cache: OsvCache) {
  try {
    fs.mkdirSync(cacheDirectory, { recursive: true });
    const filename = path.join(cacheDirectory, cacheFileName);
    const temporary = `${filename}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(cache));
    fs.renameSync(temporary, filename);
  } catch {
    // Ignored on purpose; see above.
  }
}

// The code of the system error behind a failed request, or the error's own message.
function describeNetworkError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const { cause } = error;
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  return String(code ?? error.message);
}

interface OsvBatchBody {
  results?: OsvBatchResult[];
}

function isBatchBody(value: unknown): value is OsvBatchBody {
  return isRecord(value) && (value.results === undefined || Array.isArray(value.results));
}

function isVulnerabilityRecord(value: unknown): value is OsvRecord {
  return isRecord(value) && typeof value.id === 'string';
}

// A body is accepted only when the caller's guard confirms the part of its shape the report reads.
async function requestJson<Body>(
  fetchImpl: typeof fetch,
  url: string,
  isBody: (value: unknown) => value is Body,
  init?: RequestInit,
): Promise<Body> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
  } catch (error) {
    throw new Error(
      `Could not reach the OSV vulnerability database (${describeNetworkError(error)}). Check the network connection and retry.`,
    );
  }
  if (!response.ok) throw new Error(`The OSV vulnerability database answered HTTP ${response.status} for ${url}.`);
  // A proxy or captive portal can answer 200 with HTML or an empty body; that must read as a
  // database problem.
  const body: unknown = await response.json().catch(() => null);
  if (!isBody(body)) {
    throw new Error(`The OSV vulnerability database returned an unexpected answer for ${url}. Retry later.`);
  }
  return body;
}

// Keeps what the report needs, so the cache stays small.
function summarizeVulnerability(vulnerability: OsvRecord): OsvVulnerability {
  return {
    id: vulnerability.id,
    aliases: vulnerability.aliases ?? [],
    summary: vulnerability.summary ?? '',
    withdrawn: Boolean(vulnerability.withdrawn),
    severity: vulnerability.severity ?? [],
    databaseSeverity: vulnerability.database_specific?.severity,
    affected: (vulnerability.affected ?? []).flatMap(({ package: affectedPackage, ranges }) =>
      affectedPackage?.ecosystem === 'npm' ? [{ name: affectedPackage.name, ranges: ranges ?? [] }] : [],
    ),
  };
}

async function requestBatch(fetchImpl: typeof fetch, origin: string, queries: OsvQuery[]): Promise<OsvBatchResult[]> {
  const body = await requestJson(fetchImpl, `${origin}/v1/querybatch`, isBatchBody, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ queries }),
  });
  if (!Array.isArray(body.results) || body.results.length !== queries.length) {
    throw new Error('The OSV vulnerability database returned an unexpected answer to the batch query.');
  }
  return body.results;
}

// OSV pages a query's results with next_page_token; only the queries that have more pages are sent
// again. The cap stops a server that keeps answering with a token from looping forever.
const maxBatchPages = 100;

async function queryBatch(
  fetchImpl: typeof fetch,
  origin: string,
  packages: readonly PackageVersion[],
): Promise<string[][]> {
  const idLists: string[][] = packages.map(() => []);
  let pending: { index: number; query: OsvQuery }[] = packages.map(({ name, version }, index) => ({
    index,
    query: { package: { name, ecosystem: 'npm' }, version },
  }));
  for (let page = 0; pending.length; page++) {
    if (page === maxBatchPages) {
      throw new Error('The OSV vulnerability database kept paging the batch query. Retry later.');
    }
    const results = await requestBatch(
      fetchImpl,
      origin,
      pending.map(({ query }) => query),
    );
    const nextPending: typeof pending = [];
    results.forEach((result, position) => {
      const { index, query } = pending[position];
      idLists[index].push(...(result.vulns ?? []).map(({ id }) => id));
      if (result.next_page_token) nextPending.push({ index, query: { ...query, page_token: result.next_page_token } });
    });
    pending = nextPending;
  }
  return idLists;
}

async function fetchVulnerabilities(fetchImpl: typeof fetch, origin: string, ids: readonly string[]) {
  const fetched: OsvVulnerability[] = [];
  const pending = [...ids];
  const workers = Array.from({ length: Math.min(detailConcurrency, pending.length) }, async () => {
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
      const detail = await requestJson(
        fetchImpl,
        `${origin}/v1/vulns/${encodeURIComponent(id)}`,
        isVulnerabilityRecord,
      );
      fetched.push(summarizeVulnerability(detail));
    }
  });
  await Promise.all(workers);
  return fetched;
}

// Resolves to Map<"name@version", vulnerability[]> for the packages that have advisories.
async function findVulnerabilities(
  packages: readonly PackageVersion[],
  { fetchImpl = fetch, cacheDirectory, now = Date.now() }: VulnerabilityLookupOptions = {},
) {
  const origin = configuredOrigin();
  const cachePath = cacheDirectory ?? (origin === osvOrigin ? defaultCacheDirectory() : undefined);
  const cache = readCache(cachePath, now);
  const keyOf = ({ name, version }: PackageVersion) => `${name}@${version}`;
  const uncached = packages.filter((entry) => !cache.queries[keyOf(entry)]);
  for (let start = 0; start < uncached.length; start += maxBatchSize) {
    const batch = uncached.slice(start, start + maxBatchSize);
    const idLists = await queryBatch(fetchImpl, origin, batch);
    batch.forEach((entry, index) => {
      cache.queries[keyOf(entry)] = { at: now, ids: idLists[index] };
    });
  }
  const wantedIds = new Set(packages.flatMap((entry) => cache.queries[keyOf(entry)].ids));
  const missingIds = [...wantedIds].filter((id) => !cache.vulnerabilities[id]);
  for (const vulnerability of await fetchVulnerabilities(fetchImpl, origin, missingIds)) {
    cache.vulnerabilities[vulnerability.id] = { at: now, vulnerability };
  }
  if (cachePath && (uncached.length || missingIds.length)) writeCache(cachePath, cache);
  const found = new Map<string, OsvVulnerability[]>();
  for (const entry of packages) {
    const vulnerabilities = cache.queries[keyOf(entry)].ids
      .map((id) => cache.vulnerabilities[id].vulnerability)
      .filter(({ withdrawn }) => !withdrawn);
    if (vulnerabilities.length) found.set(keyOf(entry), vulnerabilities);
  }
  return found;
}

export { findVulnerabilities, defaultCacheDirectory, maxBatchSize };
