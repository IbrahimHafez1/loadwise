'use strict';

// Looks up npm package versions in the GitHub Advisory Database through the OSV API. Only package names and versions
// leave the machine. Answers are cached for a day so a repeated run makes no requests.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

function readCache(cacheDirectory, now) {
  const empty = { queries: {}, vulnerabilities: {} };
  if (!cacheDirectory) return empty;
  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(path.join(cacheDirectory, cacheFileName), 'utf8'));
  } catch {
    return empty;
  }
  const isFresh = (entry) => now - entry.at < cacheLifetimeMs;
  for (const section of ['queries', 'vulnerabilities']) {
    cache[section] = Object.fromEntries(Object.entries(cache[section] ?? {}).filter(([, entry]) => isFresh(entry)));
  }
  return cache;
}

// A cache that cannot be written only costs speed, so failures here must not fail the check.
function writeCache(cacheDirectory, cache) {
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

async function requestJson(fetchImpl, url, init) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
  } catch (error) {
    throw new Error(
      `Could not reach the OSV vulnerability database (${error.cause?.code ?? error.message}). Check the network connection and retry.`,
    );
  }
  if (!response.ok) throw new Error(`The OSV vulnerability database answered HTTP ${response.status} for ${url}.`);
  return response.json();
}

// Keeps what the report needs, so the cache stays small.
function summarizeVulnerability(vulnerability) {
  return {
    id: vulnerability.id,
    aliases: vulnerability.aliases ?? [],
    summary: vulnerability.summary ?? '',
    withdrawn: Boolean(vulnerability.withdrawn),
    severity: vulnerability.severity ?? [],
    databaseSeverity: vulnerability.database_specific?.severity,
    affected: (vulnerability.affected ?? [])
      .filter(({ package: affectedPackage }) => affectedPackage?.ecosystem === 'npm')
      .map(({ package: affectedPackage, ranges }) => ({ name: affectedPackage.name, ranges: ranges ?? [] })),
  };
}

async function queryBatch(fetchImpl, origin, packages) {
  const queries = packages.map(({ name, version }) => ({ package: { name, ecosystem: 'npm' }, version }));
  const body = await requestJson(fetchImpl, `${origin}/v1/querybatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ queries }),
  });
  if (!Array.isArray(body.results) || body.results.length !== packages.length) {
    throw new Error('The OSV vulnerability database returned an unexpected answer to the batch query.');
  }
  return body.results.map((result) => (result.vulns ?? []).map(({ id }) => id));
}

async function fetchVulnerabilities(fetchImpl, origin, ids) {
  const fetched = [];
  const pending = [...ids];
  const workers = Array.from({ length: Math.min(detailConcurrency, pending.length) }, async () => {
    while (pending.length) {
      const id = pending.pop();
      const detail = await requestJson(fetchImpl, `${origin}/v1/vulns/${encodeURIComponent(id)}`);
      fetched.push(summarizeVulnerability(detail));
    }
  });
  await Promise.all(workers);
  return fetched;
}

// Resolves to Map<"name@version", vulnerability[]> for the packages that have advisories.
async function findVulnerabilities(packages, { fetchImpl = fetch, cacheDirectory, now = Date.now() } = {}) {
  const origin = configuredOrigin();
  const cachePath = cacheDirectory ?? (origin === osvOrigin ? defaultCacheDirectory() : undefined);
  const cache = readCache(cachePath, now);
  const keyOf = ({ name, version }) => `${name}@${version}`;
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
  const found = new Map();
  for (const entry of packages) {
    const vulnerabilities = cache.queries[keyOf(entry)].ids
      .map((id) => cache.vulnerabilities[id].vulnerability)
      .filter(({ withdrawn }) => !withdrawn);
    if (vulnerabilities.length) found.set(keyOf(entry), vulnerabilities);
  }
  return found;
}

module.exports = { findVulnerabilities, defaultCacheDirectory, maxBatchSize };
