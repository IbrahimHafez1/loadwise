import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintWithoutTypes } from './helpers.js';
import type { LocatedFinding } from '../types/security.js';

const ruleId = 'zip-slip-extraction';

function findings(lines: string[]) {
  return lintWithoutTypes(lines.join('\n')).filter((finding: LocatedFinding) => finding.ruleId === ruleId);
}

test('entry names of adm-zip, yauzl and unzipper written without a check are reported', () => {
  const admZip = findings([
    "import AdmZip from 'adm-zip';",
    "import fs from 'fs';",
    "import path from 'path';",
    'export function unpack(archive: string, destination: string) {',
    '  for (const entry of new AdmZip(archive).getEntries())',
    '    fs.writeFileSync(path.join(destination, entry.entryName), entry.getData());',
    '}',
  ]);
  assert.equal(admZip.length, 1);
  assert.match(admZip[0].message, /containment check/);
  const yauzl = findings([
    "import * as yauzl from 'yauzl';",
    "import { createWriteStream } from 'fs';",
    'declare const zipfile: yauzl.ZipFile;',
    'export function unpack(destination: string) {',
    "  zipfile.on('entry', (entry: any) => {",
    '    const target = `${destination}/${entry.fileName}`;',
    '    zipfile.openReadStream(entry, (error: unknown, stream: any) => stream.pipe(createWriteStream(target)));',
    '  });',
    '}',
  ]);
  assert.equal(yauzl.length, 1);
  const unzipper = findings([
    "const unzipper = require('unzipper');",
    "const fs = require('fs');",
    'declare const input: any;',
    "input.pipe(unzipper.Parse()).on('entry', (entry: any) => entry.pipe(fs.createWriteStream('/out/' + entry.path)));",
  ]);
  assert.equal(unzipper.length, 1);
});

test('a containment check, basename, directory checks and non-archive files behave as expected', () => {
  const header = ["import AdmZip from 'adm-zip';", "import fs from 'fs';", "import path from 'path';"];
  const contained = findings([
    ...header,
    'export function unpack(archive: string, destination: string) {',
    '  for (const entry of new AdmZip(archive).getEntries()) {',
    '    const target = path.resolve(destination, entry.entryName);',
    '    if (!target.startsWith(destination + path.sep)) continue;',
    '    fs.writeFileSync(target, entry.getData());',
    '  }',
    '}',
  ]);
  assert.equal(contained.length, 0);
  const flattened = findings([
    ...header,
    'export function unpack(archive: string, destination: string) {',
    '  for (const entry of new AdmZip(archive).getEntries())',
    '    fs.writeFileSync(path.join(destination, path.basename(entry.entryName)), entry.getData());',
    '}',
  ]);
  assert.equal(flattened.length, 0);
  const directoryCheckOnly = findings([
    "import * as yauzl from 'yauzl';",
    "import fs from 'fs';",
    'declare const zipfile: yauzl.ZipFile;',
    "zipfile.on('entry', (entry: any) => {",
    "  if (entry.fileName.endsWith('/')) fs.mkdirSync('/out/' + entry.fileName);",
    '});',
  ]);
  assert.equal(directoryCheckOnly.length, 1);
  const notArchive = findings([
    "import fs from 'fs';",
    'declare const items: { name: string }[];',
    "for (const item of items) fs.writeFileSync('/out/' + item.name, '');",
  ]);
  assert.equal(notArchive.length, 0);
  const extractAll = findings([...header, "new AdmZip('a.zip').extractAllTo('/out', true);"]);
  assert.equal(extractAll.length, 0);
});

test('archive entries reach a local write helper without classifying an unrelated collection', () => {
  const header = [
    "import Archive from 'adm-zip';",
    "import { writeFileSync } from 'node:fs';",
    "import { join as combine } from 'node:path';",
    'declare const input: string, destination: string;',
    'function save(name: string) { writeFileSync(combine(destination, name), "sample"); }',
  ];
  const fromArchive = findings([
    ...header,
    'const entries = new Archive(input).getEntries();',
    'for (const { entryName } of entries) save(entryName);',
  ]);
  assert.equal(fromArchive.length, 1);
  assert.ok(fromArchive[0].trace && fromArchive[0].trace.length > 1);
  const unrelated = findings([
    ...header,
    'declare const library: { getEntries(): { name: string }[] };',
    'for (const entry of library.getEntries()) writeFileSync(combine(destination, entry.name), "sample");',
  ]);
  assert.equal(unrelated.length, 0);
});

test('JSZip filename callbacks and tar entry headers feed the same archive trace', () => {
  const jszip = findings([
    "import JSZip from 'jszip';",
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'declare const destination: string;',
    'new JSZip().forEach((name: string) => writeFileSync(join(destination, name), "sample"));',
  ]);
  assert.equal(jszip.length, 1);
  const tar = findings([
    "import { extract } from 'tar-stream';",
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'declare const destination: string;',
    "extract().on('entry', ({ name }: { name: string }) => writeFileSync(join(destination, name), 'sample'));",
  ]);
  assert.equal(tar.length, 1);
});
