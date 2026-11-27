import type { Redactor } from '../types/db-connection.js';

interface RedactorSecrets {
  url?: string;
  user?: string;
  password?: string;
  hosts?: readonly string[];
  extra?: readonly string[];
}

interface SafeError {
  code: string | undefined;
  message: string;
}

interface ParsedConnectionUrl {
  scheme: string;
  user: string;
  rawUserInfo: string;
  password: string;
  hosts: string[];
  database: string;
}

const replacement = '[redacted]';
// Socket errors print the resolved address, which is the host in another form.
const socketErrorTarget = /\b((?:connect|getaddrinfo|querySrv|queryTxt)\s+E[A-Z]+)\s+\S+/g;
const ipv4Address = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;
const bracketedIpv6Address = /\[[0-9a-fA-F:.]+\](?::\d+)?/g;
const minimumLabelsForParentDomain = 3;
const minimumSubstringSecretLength = 4;

function escapeRegExp(text: string) {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function forms(value: string | undefined): string[] {
  if (typeof value !== 'string' || value === '') return [];
  const variants = new Set([value]);
  try {
    variants.add(decodeURIComponent(value));
  } catch {
    // A malformed escape cannot be decoded; the raw form is still redacted.
  }
  variants.add(encodeURIComponent(value));
  return [...variants].filter(Boolean);
}

// SRV and cluster hosts resolve to sibling names (shard-00-00.abc.mongodb.net), so the parent
// domain is secret too.
function hostForms(host: string): string[] {
  const values = forms(host);
  const labels = host.split('.');
  if (labels.length >= minimumLabelsForParentDomain && !/^\d+$/.test(labels.at(-1) ?? '')) {
    values.push(...forms(labels.slice(1).join('.')));
  }
  return values;
}

function createRedactor({ url, user, password, hosts = [], extra = [] }: RedactorSecrets = {}): Redactor {
  const secrets = new Set([
    ...forms(url),
    ...forms(user),
    ...forms(password),
    ...hosts.flatMap(hostForms),
    ...extra.flatMap(forms),
  ]);
  // Longest first, so a password containing the user name is removed whole.
  const ordered = [...secrets].sort((left, right) => right.length - left.length);
  const longPatterns = ordered
    .filter((secret) => secret.length >= minimumSubstringSecretLength)
    .map((secret) => new RegExp(escapeRegExp(secret), 'gi'));
  // Very short values (user `u`, host `db`) are replaced only as whole tokens: replacing every
  // letter would garble the message and reveal the value by the pattern of the gaps.
  const shortTokens = ordered
    .filter((secret) => secret.length < minimumSubstringSecretLength)
    .map((secret) => new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(secret)}(?![A-Za-z0-9_])`, 'g'));
  return function redact(text: unknown): string {
    let result = String(text ?? '');
    for (const pattern of longPatterns) result = result.replaceAll(pattern, replacement);
    for (const token of shortTokens) result = result.replace(token, replacement);
    return result
      .replaceAll(socketErrorTarget, `$1 ${replacement}`)
      .replaceAll(ipv4Address, replacement)
      .replaceAll(bracketedIpv6Address, replacement);
  };
}

// Only the code and the redacted message leave this module: never the stack or the driver's
// connection object.
function errorField(error: unknown, field: 'code' | 'message'): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  if (field === 'code') return 'code' in error ? error.code : undefined;
  return 'message' in error ? error.message : undefined;
}

function safeError(error: unknown, redact: Redactor): SafeError {
  const rawCode = errorField(error, 'code');
  const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : undefined;
  const message = redact(errorField(error, 'message') ?? String(error));
  return { code: code === undefined ? undefined : redact(code), message };
}

function describeError(error: unknown, redact: Redactor): string {
  const { code, message } = safeError(error, redact);
  return code ? `${code}: ${message}` : message;
}

// Parses scheme://user:password@host1:port,host2/db?options without WHATWG URL, which rejects
// multi-host strings.
function parseConnectionUrl(url: string | undefined): ParsedConnectionUrl | undefined {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/s.exec(url ?? '');
  if (!match) return;
  const [, scheme, rest] = match;
  const queryStart = rest.indexOf('?');
  const beforeQuery = queryStart === -1 ? rest : rest.slice(0, queryStart);
  // Unencoded passwords may contain `@` or `/`, host lists contain neither, and database paths may
  // contain `@`. When an `@` comes before the first `/`, the last such `@` ends the user info and
  // later ones belong to the path; otherwise the `/` sits in the password and the last `@` overall
  // ends it.
  const firstSlash = beforeQuery.indexOf('/');
  const authorityAt = (firstSlash === -1 ? beforeQuery : beforeQuery.slice(0, firstSlash)).lastIndexOf('@');
  const at = authorityAt === -1 ? beforeQuery.lastIndexOf('@') : authorityAt;
  const userInfo = at === -1 ? '' : beforeQuery.slice(0, at);
  const afterUserInfo = beforeQuery.slice(at + 1);
  const pathStart = afterUserInfo.indexOf('/');
  const hostList = pathStart === -1 ? afterUserInfo : afterUserInfo.slice(0, pathStart);
  const pathname = pathStart === -1 ? '' : afterUserInfo.slice(pathStart + 1);
  const colon = userInfo.indexOf(':');
  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const hosts = hostList
    .split(',')
    .map((entry) => /^\[([^\]]*)\]/.exec(entry)?.[1] ?? entry.replace(/:\d*$/, ''))
    .filter(Boolean);
  return {
    scheme: scheme.toLowerCase(),
    user: decode(colon === -1 ? userInfo : userInfo.slice(0, colon)),
    rawUserInfo: userInfo,
    password: colon === -1 ? '' : decode(userInfo.slice(colon + 1)),
    hosts,
    database: decode(pathname.split('/')[0] ?? ''),
  };
}

export { createRedactor, safeError, describeError, parseConnectionUrl, replacement };
