'use strict';

// committed-secret: credentials in tracked files. Messages name the key and a four-character prefix, never the value.
const {
  isDefaultPassword,
  isSecretKey,
  isPlaceholderValue,
  looksLikeSampleToken,
  urlCredentials,
  redactedPrefix,
} = require('./secret-values.cjs');
const { isEnvFileName } = require('./project-files.cjs');

const ruleId = 'committed-secret';
const templateEnvSuffix = /\.(?:example|sample|template|dist)$/i;
const testEnvSuffix = /\.test$/i;
const envLine = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/;
const localCredentialsReason = 'Default credentials for a local service.';
const testEnvReason = 'Test environment file.';

// High-confidence formats only: each has a fixed prefix and a fixed or long random body.
const tokenFormats = [
  { label: 'AWS access key id', pattern: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g },
  { label: 'GitHub token', pattern: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,}(?![A-Za-z0-9_])/g },
  { label: 'GitHub token', pattern: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,}(?![A-Za-z0-9_])/g },
  { label: 'Slack token', pattern: /(?<![A-Za-z0-9])xox[bp]-[0-9A-Za-z-]{10,}/g },
  { label: 'Stripe live secret key', pattern: /(?<![A-Za-z0-9_])sk_live_[0-9A-Za-z]{24,}(?![A-Za-z0-9])/g },
  { label: 'Google API key', pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
];
// A header alone appears in code that parses keys; a base64 body after it is a real key.
const privateKeyBlock = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----(?:\\r|\\n|\s)*[A-Za-z0-9+/=]{40,}/g;

function tokenFindings(line, lineNumber) {
  const found = [];
  for (const { label, pattern } of tokenFormats) {
    for (const match of line.matchAll(pattern)) {
      if (looksLikeSampleToken(match[0])) continue;
      found.push({
        line: lineNumber,
        column: match.index + 1,
        message: `${label} (${redactedPrefix(match[0])}) is committed in a tracked file.`,
      });
    }
  }
  return found;
}

// The body follows the header on later lines, so this reads the whole text.
function privateKeyFindings(text) {
  return [...text.matchAll(privateKeyBlock)].map((match) => {
    const before = text.slice(0, match.index);
    return {
      line: before.split('\n').length,
      column: match.index - before.lastIndexOf('\n'),
      message: 'A private key block is committed in a tracked file.',
    };
  });
}

function unquote(rawValue) {
  const trimmed = rawValue.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  return trimmed.replace(/\s+#.*$/, '');
}

function envEntryFinding(line, lineNumber, isTestFile) {
  const match = envLine.exec(line);
  if (!match) return undefined;
  const [, key, rawValue] = match;
  const value = unquote(rawValue);
  const credentials = urlCredentials(value);
  const isDefault = credentials?.local || isDefaultPassword(value);
  const contextualReason = isDefault ? localCredentialsReason : isTestFile ? testEnvReason : undefined;
  const base = { line: lineNumber, column: 1, ...(contextualReason && { contextualReason }) };
  if (credentials) {
    return { ...base, message: `Tracked env file embeds credentials in "${key}" (starts "${redactedPrefix(value)}").` };
  }
  if (!isSecretKey(key) || isPlaceholderValue(value, key)) return undefined;
  return { ...base, message: `Tracked env file holds a value for "${key}" (starts "${redactedPrefix(value)}").` };
}

// Template env files hold only placeholders by design, so only token formats count there.
function checkSecrets(file, text) {
  const baseName = file.split('/').at(-1);
  const readsEntries = isEnvFileName(baseName) && !templateEnvSuffix.test(baseName);
  const isTestFile = testEnvSuffix.test(baseName);
  const findings = privateKeyFindings(text);
  text.split(/\r?\n/).forEach((line, index) => {
    const tokens = tokenFindings(line, index + 1);
    if (tokens.length) return findings.push(...tokens);
    const entry = readsEntries && envEntryFinding(line, index + 1, isTestFile);
    if (entry) findings.push(entry);
  });
  return findings.map((finding) => ({ ruleId, ...finding }));
}

module.exports = { checkSecrets };
