import fs from 'node:fs';
import type { SourceFile } from 'typescript';
import { runtimeDirectories } from './runtime-directories.cjs';

// What later steps need to know about a source file's text, gathered while the scan already holds
// it so that they do not read the same file from disk again.
const maxConsumerBytes = 1024 * 1024;
const placeholderMaxBytes = 1024;

// Every character an identifier can hold. A name made only of these characters can occur in a text
// only inside one maximal run of them, so searching the distinct runs finds exactly the names a
// search of the text finds.
const identifierCharacters = '[\\w$\\u0080-\\uffff]';
const identifierRun = new RegExp(`${identifierCharacters}+`, 'g');
const pureName = new RegExp(`^${identifierCharacters}+$`);

function identifierIndexOf(text: string) {
  return [...new Set(text.match(identifierRun))].join('\n');
}

// An index is only exact for plain names; anything else is searched in the full text.
function canUseIndex(name: string): boolean {
  return pureName.test(name);
}

interface DiskFacts {
  size: number;
  utf16?: boolean;
}

interface SourceFactsOptions {
  indexIdentifiers?: boolean;
}

interface SourceFactsResult {
  placeholder: boolean;
  runtimeFolders: string[];
  identifierIndex?: string;
}

// `size` is the file's size in bytes. UTF-16 files are decoded differently by later readers, so
// they get no index.
function sourceFacts(
  source: SourceFile,
  text: string,
  { size, utf16 }: DiskFacts,
  { indexIdentifiers }: SourceFactsOptions = {},
): SourceFactsResult {
  return {
    placeholder: size <= placeholderMaxBytes && source.statements.length === 0,
    runtimeFolders: size > 0 && size <= maxConsumerBytes ? [...runtimeDirectories(text)] : [],
    ...(indexIdentifiers && !utf16 && { identifierIndex: identifierIndexOf(text) }),
  };
}

// An unreadable or malformed manifest says nothing about publishing, so the package counts as
// public.
function isPrivateManifest(manifest: string): boolean {
  try {
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).private === true;
  } catch {
    return false;
  }
}

export { maxConsumerBytes, placeholderMaxBytes, identifierIndexOf, canUseIndex, sourceFacts, isPrivateManifest };
