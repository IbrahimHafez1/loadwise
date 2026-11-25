import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingsOf } from './exposure-helpers.js';
import { stubs } from './helpers.js';

const xssRule = 'reflected-xss-response';
const xmlRule = 'xml-external-entities';
const route = (body: string) =>
  `import express from 'express';\ndeclare function escapeHtml(value: string): string;\nconst app = express();\napp.get('/greet', (req, res) => { ${body} });`;

test('request data inside an HTML string sent back is reported, as contextual only', () => {
  const bodies = [
    'res.send(`<h1>Hello ${req.query.name}</h1>`);',
    "res.send('<h1>Hello ' + req.query.name + '</h1>');",
    'const name = req.query.name; res.send(`<p>${name}</p>`);',
  ];
  for (const body of bodies) {
    const findings = findingsOf(xssRule, route(body), stubs.express);
    assert.equal(findings.length, 1, body);
    assert.ok(findings[0].contextualReason, body);
    assert.match(findings[0].message, /^`req\.query\.name` is placed into an HTML response/);
  }
});

test('escaped values, JSON, plain text and server data are clean', () => {
  const bodies = [
    'res.send(`<h1>Hello ${escapeHtml(req.query.name)}</h1>`);',
    'res.json({ html: `<h1>${req.query.name}</h1>` });',
    "res.type('json').send(`<${req.query.name}>`);",
    'res.send(`Hello ${req.query.name}`);',
    'res.send(`<h1>Hello ${req.user.name}</h1>`);',
    'res.send("<h1>Hello</h1>");',
  ];
  for (const body of bodies) assert.equal(findingsOf(xssRule, route(body), stubs.express).length, 0, body);
});

const libxmlStub = {
  'node_modules/libxmljs/index.d.ts':
    'export declare function parseXml(xml: string, options?: object): object;\nexport declare function parseXmlString(xml: string, options?: object): object;',
};

test('libxmljs options that load external entities are reported', () => {
  const bodies = [
    "import { parseXml } from 'libxmljs';\ndeclare const xml: string;\nparseXml(xml, { noent: true });",
    "import * as libxml from 'libxmljs';\ndeclare const xml: string;\nlibxml.parseXmlString(xml, { dtdload: true, nonet: true });",
    "import libxml from 'libxmljs2';\ndeclare const xml: string;\nlibxml.parseXml(xml, { noent: true, dtdload: true });",
  ];
  const counts = [1, 1, 2];
  bodies.forEach((source, index) => {
    assert.equal(findingsOf(xmlRule, source, libxmlStub).length, counts[index], source);
  });
});

test('default options, false values and other parsers are clean', () => {
  const bodies = [
    "import { parseXml } from 'libxmljs';\ndeclare const xml: string;\nparseXml(xml);",
    "import { parseXml } from 'libxmljs';\ndeclare const xml: string;\nparseXml(xml, { noent: false, nonet: true });",
    "import { parseXml } from 'libxmljs';\ndeclare const xml: string, flag: boolean;\nparseXml(xml, { noent: flag });",
    "declare function parseXml(xml: string, options: object): void;\nparseXml('', { noent: true });",
    "import { XMLParser } from 'fast-xml-parser';\nnew XMLParser({ processEntities: true });",
  ];
  for (const source of bodies) assert.equal(findingsOf(xmlRule, source, libxmlStub).length, 0, source);
});
