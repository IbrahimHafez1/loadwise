'use strict';

const replacement = '[redacted]';
// Socket errors print the resolved address, which is the host in another form.
const socketErrorTarget = /\b((?:connect|getaddrinfo|querySrv|queryTxt)\s+E[A-Z]+)\s+\S+/g;
const ipv4Address = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;
const bracketedIpv6Address = /\[[0-9a-fA-F:.]+\](?::\d+)?/g;
const minimumLabelsForParentDomain = 3;

function forms(value) {
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

// SRV and cluster hosts resolve to sibling names (shard-00-00.abc.mongodb.net), so the parent domain is secret too.
function hostForms(host) {
  const values = forms(host);
  const labels = host.split('.');
  if (labels.length >= minimumLabelsForParentDomain && !/^\d+$/.test(labels.at(-1))) {
    values.push(...forms(labels.slice(1).join('.')));
  }
  return values;
}

function createRedactor({ url, user, password, hosts = [], extra = [] } = {}) {
  const secrets = new Set([
    ...forms(url),
    ...forms(user),
    ...forms(password),
    ...hosts.flatMap(hostForms),
    ...extra.flatMap(forms),
  ]);
  // Longest first, so a password containing the user name is removed whole.
  const ordered = [...secrets].sort((left, right) => right.length - left.length);
  return function redact(text) {
    let result = String(text ?? '');
    for (const secret of ordered) result = result.split(secret).join(replacement);
    return result
      .replace(socketErrorTarget, `$1 ${replacement}`)
      .replace(ipv4Address, replacement)
      .replace(bracketedIpv6Address, replacement);
  };
}

// Only the code and the redacted message leave this module: never the stack or the driver's connection object.
function safeError(error, redact) {
  const code = typeof error?.code === 'string' || typeof error?.code === 'number' ? String(error.code) : undefined;
  const message = redact(error?.message ?? String(error));
  return { code: code === undefined ? undefined : redact(code), message };
}

function describeError(error, redact) {
  const { code, message } = safeError(error, redact);
  return code ? `${code}: ${message}` : message;
}

// Parses scheme://user:password@host1:port,host2/db?options without WHATWG URL, which rejects multi-host strings.
function parseConnectionUrl(url) {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/s.exec(url ?? '');
  if (!match) return;
  const [, scheme, rest] = match;
  const queryStart = rest.indexOf('?');
  const beforeQuery = queryStart === -1 ? rest : rest.slice(0, queryStart);
  // The last @ ends the user info, because unencoded passwords may contain @ but host lists cannot.
  const at = beforeQuery.lastIndexOf('@');
  const userInfo = at === -1 ? '' : beforeQuery.slice(0, at);
  const afterUserInfo = beforeQuery.slice(at + 1);
  const pathStart = afterUserInfo.indexOf('/');
  const hostList = pathStart === -1 ? afterUserInfo : afterUserInfo.slice(0, pathStart);
  const pathname = pathStart === -1 ? '' : afterUserInfo.slice(pathStart + 1);
  const colon = userInfo.indexOf(':');
  const decode = (value) => {
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

module.exports = { createRedactor, safeError, describeError, parseConnectionUrl, replacement };
