'use strict';

// compose-hardcoded-secret: secret-looking keys under `environment:` that carry a literal value.
const { isDefaultPassword, isSecretKey, isPlaceholderValue, redactedPrefix } = require('./secret-values.cjs');

const localCredentialsReason = 'Default credentials for a local service.';
const composeName = /^(?:docker-)?compose(?:[.-].+)?\.ya?ml$|\.compose\.ya?ml$/i;
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

function checkCompose(text) {
  const findings = [];
  let environmentIndent;
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    const indent = /^\s*/.exec(line)[0].length;
    if (environmentIndent !== undefined && indent <= environmentIndent) environmentIndent = undefined;
    const header = environmentHeader.exec(line);
    if (header) environmentIndent = header[1].length;
    if (environmentIndent === undefined || header) return;
    const entry = entryOf(line);
    if (!entry || !isSecretKey(entry.key) || isPlaceholderValue(entry.value, entry.key)) return;
    findings.push({
      ruleId: 'compose-hardcoded-secret',
      line: index + 1,
      column: indent + 1,
      ...(isDefaultPassword(entry.value) && { contextualReason: localCredentialsReason }),
      message: `Compose environment sets "${entry.key}" to a literal value (starts "${redactedPrefix(entry.value)}"). Read it from an env file or a secret instead.`,
    });
  });
  return findings;
}

module.exports = { checkCompose, isComposeFile };
