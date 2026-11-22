'use strict';

// compose-hardcoded-secret: secret-looking keys under `environment:` that carry a literal value.
const { isDefaultPassword, isSecretKey, isPlaceholderValue, redactedPrefix } = require('./secret-values.cjs');

const localCredentialsReason = 'Default credentials for a local service.';
const localServiceReason = 'Credentials of a local datastore container.';
const composeName = /^(?:docker-)?compose(?:[.-].+)?\.ya?ml$|\.compose\.ya?ml$/i;
// Stock datastore and object-store images are started with throwaway credentials next to the code that uses them.
const datastoreImage =
  /^\s*image:\s*["']?(?:[\w.-]+\/)*[\w.-]*(?:postgres|mysql|mariadb|mongo|redis|oracle|mssql|sqlserver|cockroach|minio|rustfs|localstack|rabbitmq|clickhouse|elasticsearch|opensearch)/i;
const environmentHeader = /^(\s*)environment:\s*(?:#.*)?$/;
const listEntry = /^\s*-\s*["']?([A-Za-z_][\w.]*)=(.*?)["']?\s*$/;
const mapEntry = /^\s*["']?([A-Za-z_][\w.]*)["']?\s*:\s*(.+?)\s*$/;

function isComposeFile(file) {
  return composeName.test(file.split('/').at(-1));
}

function entryOf(line) {
  const match = listEntry.exec(line) ?? mapEntry.exec(line);
  if (!match) return undefined;
  return { key: match[1], value: match[2].replace(/\s+#.*$/, '').replace(/^(["'])(.*)\1$/, '$2') };
}

// True when the service that owns the environment block at headerIndex runs a stock datastore image.
function runsDatastoreImage(lines, headerIndex, headerIndent) {
  const indentOf = (line) => /^\s*/.exec(line)[0].length;
  const isServiceBoundary = (line) => line.trim() && indentOf(line) < headerIndent;
  const isSiblingImage = (line) => indentOf(line) === headerIndent && datastoreImage.test(line);
  for (let index = headerIndex - 1; index >= 0 && !isServiceBoundary(lines[index]); index--) {
    if (isSiblingImage(lines[index])) return true;
  }
  for (let index = headerIndex + 1; index < lines.length && !isServiceBoundary(lines[index]); index++) {
    if (isSiblingImage(lines[index])) return true;
  }
  return false;
}

function contextualReasonFor(value, datastoreService) {
  if (datastoreService) return localServiceReason;
  return isDefaultPassword(value) ? localCredentialsReason : undefined;
}

function checkCompose(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  let environmentIndent;
  let datastoreService = false;
  lines.forEach((line, index) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    const indent = /^\s*/.exec(line)[0].length;
    if (environmentIndent !== undefined && indent <= environmentIndent) environmentIndent = undefined;
    const header = environmentHeader.exec(line);
    if (header) {
      environmentIndent = header[1].length;
      datastoreService = runsDatastoreImage(lines, index, environmentIndent);
    }
    if (environmentIndent === undefined || header) return;
    const entry = entryOf(line);
    if (!entry || !isSecretKey(entry.key) || isPlaceholderValue(entry.value, entry.key)) return;
    findings.push({
      ruleId: 'compose-hardcoded-secret',
      line: index + 1,
      column: indent + 1,
      ...(contextualReasonFor(entry.value, datastoreService) && {
        contextualReason: contextualReasonFor(entry.value, datastoreService),
      }),
      message: `Compose environment sets "${entry.key}" to a literal value (starts "${redactedPrefix(entry.value)}"). Read it from an env file or a secret instead.`,
    });
  });
  return findings;
}

module.exports = { checkCompose, isComposeFile };
