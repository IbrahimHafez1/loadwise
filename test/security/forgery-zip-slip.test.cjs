'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lintWithoutTypes } = require('./helpers.cjs');

const ruleId = 'zip-slip-extraction';

function findings(lines) {
  return lintWithoutTypes(lines.join('\n')).filter((finding) => finding.ruleId === ruleId);
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
  assert.match(admZip[0].message, /`\.\.\/\.\.\/x`/);
  const yauzl = findings([
    "import yauzl from 'yauzl';",
    "import { createWriteStream } from 'fs';",
    'declare const zipfile: any;',
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
    "import yauzl from 'yauzl';",
    "import fs from 'fs';",
    'declare const zipfile: any;',
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
