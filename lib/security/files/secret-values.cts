// What counts as a secret-looking key and a real (non-placeholder) value, shared by .env,
// Dockerfile and compose checks.
const secretWords = new Set(['SECRET', 'TOKEN', 'PASSWORD', 'PASSWD', 'APIKEY', 'CREDENTIALS']);
const secretWordPairs = new Set(['API_KEY', 'PRIVATE_KEY', 'ACCESS_KEY', 'SECRET_KEY']);
// A trailing word like these means the key holds a setting about a secret, not the secret itself.
const settingSuffixes = new Set([
  'ALGORITHM',
  'AUDIENCE',
  'DURATION',
  'ENABLED',
  'EXPIRATION',
  'EXPIRES',
  'EXPIRY',
  'FILE',
  'HEADER',
  'ISSUER',
  'LENGTH',
  'MAX',
  'MIN',
  'MS',
  'NAME',
  'PATH',
  'PREFIX',
  'REGEX',
  'SECONDS',
  'TTL',
  'TYPE',
]);
// Frameworks ship these variables to the browser on purpose.
const publicPrefix = /^(?:NEXT_PUBLIC|NUXT_PUBLIC|EXPO_PUBLIC|VITE|REACT_APP|PUBLIC)_/;
const minimumSecretLength = 8;
const placeholderPattern =
  /change.?me|example|sample|dummy|fake|placeholder|your[-_ ]|<[^>]*>|\$\{|\$\(|\{\{|xxx|\*{3}|\.{3}|todo|replace|insert|here$|(?:^|[^a-z])(?:test|testing|dev)(?:[^a-z]|$)/i;
const literalWords = /^(?:none|null|undefined|empty|secret|password|token|admin|default|true|false|\d+)$/i;
const localHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);
const defaultPasswords = new Set([
  'postgres',
  'password',
  'root',
  'admin',
  'mysql',
  'mongo',
  'redis',
  'guest',
  'secret',
]);
const credentialedUrl = /^[a-z][a-z0-9+.-]*:\/\/([^:@/\s]+):([^@\s/]+)@(\[[^\]\s]+\]|[^/:?#\s]+)/i;

// Well-known development passwords such as postgres or testpass: worth a note, not an exposed
// production secret.
function isDefaultPassword(value: string) {
  return defaultPasswords.has(value.toLowerCase()) || /^(?:test|dev|demo)\w{0,8}$/i.test(value);
}

function isSecretKey(key: string) {
  const upper = key.toUpperCase();
  if (publicPrefix.test(upper)) return false;
  const words = upper.split(/[^A-Z0-9]+/).filter(Boolean);
  if (settingSuffixes.has(words.at(-1) ?? '')) return false;
  return words.some((word, index) => secretWords.has(word) || secretWordPairs.has(`${word}_${words[index + 1]}`));
}

function stripKey(text: string) {
  return text.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}

function isPlaceholderValue(value: string, key = '') {
  const trimmed = value.trim();
  if (trimmed.length < minimumSecretLength) return true;
  if (placeholderPattern.test(trimmed) || literalWords.test(trimmed)) return true;
  // References and file paths point at a secret stored elsewhere; op:// and vault:// are
  // secret-manager references.
  if (/^(?:\$|\/|\.\/|file:|op:\/\/|vault:\/\/)/i.test(trimmed)) return true;
  return key !== '' && stripKey(trimmed) === stripKey(key);
}

// Sample tokens in docs and tests: documented examples, repeated filler, an obvious placeholder, or
// words only (a random token body of this length always contains a digit).
function looksLikeSampleToken(token: string) {
  const hasKnownFiller = /example|sample|dummy|fake|your|xxxx|0000|1234567|abcdef/i.test(token);
  return hasKnownFiller || /(.)\1{9}/.test(token) || !/\d/.test(token);
}

// { local } for a URL that embeds a non-placeholder password; local is true for default credentials
// on a local host.
function urlCredentials(value: string): { local: boolean } | undefined {
  const match = credentialedUrl.exec(value.trim());
  if (!match) return undefined;
  const [, user, password, host] = match;
  const knownDefault = isDefaultPassword(password);
  if (!knownDefault && isPlaceholderValue(password)) return undefined;
  return { local: localHosts.has(host.toLowerCase()) && (knownDefault || user === password) };
}

function redactedPrefix(value: string) {
  return value.slice(0, 4) + '…';
}

export { isDefaultPassword, isSecretKey, isPlaceholderValue, looksLikeSampleToken, urlCredentials, redactedPrefix };
