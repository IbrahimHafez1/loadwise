'use strict';

const fs = require('node:fs');
const { runtimeDirectories } = require('./runtime-directories.cjs');

// What later steps need to know about a source file's text, gathered while the scan already holds it so that
// they do not read the same file from disk again.
const maxConsumerBytes = 1024 * 1024;
const placeholderMaxBytes = 1024;

// Every character an identifier can hold. A name made only of these characters can occur in a text only inside
// one maximal run of them, so searching the distinct runs finds exactly the names a search of the text finds.
const identifierCharacters = '[\\w$\\u0080-\\uffff]';
const identifierRun = new RegExp(`${identifierCharacters}+`, 'g');
const pureName = new RegExp(`^${identifierCharacters}+$`);

function identifierIndexOf(text) {
  return [...new Set(text.match(identifierRun))].join('\n');
}

// An index is only exact for plain names; anything else is searched in the full text.
function canUseIndex(name) {
  return pureName.test(name);
}

// `size` is the file's size in bytes. UTF-16 files are decoded differently by later readers, so they get no index.
function sourceFacts(source, text, { size, utf16 }, { indexIdentifiers } = {}) {
  return {
    placeholder: size <= placeholderMaxBytes && source.statements.length === 0,
    runtimeFolders: size > 0 && size <= maxConsumerBytes ? [...runtimeDirectories(text)] : [],
    ...(indexIdentifiers && !utf16 && { identifierIndex: identifierIndexOf(text) }),
  };
}

// An unreadable or malformed manifest says nothing about publishing, so the package counts as public.
function isPrivateManifest(manifest) {
  try {
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).private === true;
  } catch {
    return false;
  }
}

module.exports = {
  maxConsumerBytes,
  placeholderMaxBytes,
  identifierIndexOf,
  canUseIndex,
  sourceFacts,
  isPrivateManifest,
};
