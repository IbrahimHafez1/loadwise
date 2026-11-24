// committed-secret: credentials in tracked files. Messages name the key and a four-character
// prefix, never the value.
import {
  isDefaultPassword,
  isSecretKey,
  isPlaceholderValue,
  looksLikeSampleToken,
  urlCredentials,
  redactedPrefix,
} from './secret-values.cjs';
import { isEnvFileName } from './project-files.cjs';
import type { FileFinding, FileFindingBody } from '../types/file-finding.cjs';

const ruleId = 'committed-secret';
const templateEnvSuffix = /\.(?:example|sample|template|dist)$/i;
const testFileName = /(?:^|[._-])(?:test|tests|mock|fake|e2e)(?:[._-]|$)/i;
// A file that declares itself a local or test environment holds that environment's values.
const developmentEnvironment =
  /^\s*(?:export\s+)?NODE_ENV\s*=\s*["']?(?:local|development|dev|test)["']?\s*(?:#.*)?$/im;
const envLine = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/;
const localCredentialsReason = 'Default credentials for a local service.';
const testEnvReason = 'Test environment file.';
const developmentEnvReason = 'Local development environment file.';

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

// The same formats as ERE for `git grep`, which only has to find candidate files; the patterns
// above decide.
const tokenSearchPattern = [
  'AKIA[0-9A-Z]{16}',
  'gh[pousr]_[A-Za-z0-9]{36}',
  'github_pat_[A-Za-z0-9_]{22}',
  'xox[bp]-[0-9A-Za-z-]{10}',
  'sk_live_[0-9A-Za-z]{24}',
  'AIza[0-9A-Za-z_-]{35}',
  '-----BEGIN [A-Z ]*PRIVATE KEY-----',
].join('|');

function tokenFindings(line: string, lineNumber: number): FileFindingBody[] {
  const found: FileFindingBody[] = [];
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

// A body that ends in "..." is an excerpt shown in documentation, not a usable key.
function isTruncatedExcerpt(text: string, match: RegExpExecArray) {
  return text.startsWith('...', match.index + match[0].length);
}

// The body follows the header on later lines, so this reads the whole text.
function privateKeyFindings(text: string) {
  return [...text.matchAll(privateKeyBlock)]
    .filter((match) => !isTruncatedExcerpt(text, match))
    .map((match) => {
      const before = text.slice(0, match.index);
      return {
        line: before.split('\n').length,
        column: match.index - before.lastIndexOf('\n'),
        message: 'A private key block is committed in a tracked file.',
      };
    });
}

function unquote(rawValue: string) {
  const trimmed = rawValue.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  return trimmed.replace(/\s+#.*$/, '');
}

function envEntryFinding(
  line: string,
  lineNumber: number,
  fileReason: string | undefined,
): FileFindingBody | undefined {
  const match = envLine.exec(line);
  if (!match) return undefined;
  const [, key, rawValue] = match;
  const value = unquote(rawValue);
  const credentials = urlCredentials(value);
  const isDefault = credentials?.local || isDefaultPassword(value);
  const contextualReason = isDefault ? localCredentialsReason : fileReason;
  const base = { line: lineNumber, column: 1, ...(contextualReason && { contextualReason }) };
  if (credentials) {
    return { ...base, message: `Tracked env file embeds credentials in "${key}" (starts "${redactedPrefix(value)}").` };
  }
  if (!isSecretKey(key) || isPlaceholderValue(value, key)) return undefined;
  return { ...base, message: `Tracked env file holds a value for "${key}" (starts "${redactedPrefix(value)}").` };
}

function fileContextReason(baseName: string, text: string, readsEntries: boolean) {
  if (testFileName.test(baseName)) return testEnvReason;
  return readsEntries && developmentEnvironment.test(text) ? developmentEnvReason : undefined;
}

// Provider-format tokens stay at default level in test and dev files: leaked live credentials are
// common there. Template env files hold only placeholders by design, so only token formats count
// there.
function checkSecrets(file: string, text: string): FileFinding[] {
  const baseName = file.split('/').at(-1) ?? '';
  const readsEntries = isEnvFileName(baseName) && !templateEnvSuffix.test(baseName);
  const fileReason = fileContextReason(baseName, text, readsEntries);
  const keyBlocks = privateKeyFindings(text).map((finding) => ({
    ...(fileReason && { contextualReason: fileReason }),
    ...finding,
  }));
  const findings: FileFindingBody[] = [...keyBlocks];
  text.split(/\r?\n/).forEach((line, index) => {
    const tokens = tokenFindings(line, index + 1);
    if (tokens.length) return findings.push(...tokens);
    const entry = readsEntries && envEntryFinding(line, index + 1, fileReason);
    if (entry) findings.push(entry);
  });
  return findings.map((finding) => ({ ruleId, ...finding }));
}

export { checkSecrets, tokenSearchPattern };
