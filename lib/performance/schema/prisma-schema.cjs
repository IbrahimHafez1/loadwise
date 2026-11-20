'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createTable, createColumn, createIndex } = require('./model.cjs');

const providerDialects = { postgresql: 'postgres', postgres: 'postgres', cockroachdb: 'postgres', mysql: 'mysql' };
const indexMethods = { btree: 'btree', hash: 'hash', gin: 'gin', gist: 'gist', spgist: 'spgist', brin: 'brin' };
const scalarTypes = new Set([
  'String',
  'Boolean',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'DateTime',
  'Json',
  'Bytes',
  'Unsupported',
]);
// Re-reading a schema on every query site would dominate an editor scan; file times are checked at most this often.
const revalidateAfterMilliseconds = 2000;
const cache = new Map();

function stripComment(line) {
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '\\' && quoted) index++;
    else if (character === '"') quoted = !quoted;
    else if (!quoted && character === '/' && line[index + 1] === '/') return line.slice(0, index);
  }
  return line;
}

function depthChange(text) {
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '\\' && quoted) index++;
    else if (character === '"') quoted = !quoted;
    else if (!quoted && (character === '(' || character === '[')) depth++;
    else if (!quoted && (character === ')' || character === ']')) depth--;
  }
  return depth;
}

// Splits on commas outside quotes, brackets and parentheses.
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '\\' && quoted) index++;
    else if (character === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (character === '(' || character === '[' || character === '{') depth++;
    else if (character === ')' || character === ']' || character === '}') depth--;
    else if (character === ',' && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function closingParenthesis(text, open) {
  let depth = 0;
  let quoted = false;
  for (let index = open; index < text.length; index++) {
    const character = text[index];
    if (character === '\\' && quoted) index++;
    else if (character === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (character === '(') depth++;
    else if (character === ')' && --depth === 0) return index;
  }
  return text.length;
}

// `@id @map("x") @relation(fields: [a])` -> [{ name: 'id' }, { name: 'map', args: '"x"' }, ...]
function readAttributes(text) {
  const attributes = [];
  const pattern = /@(@?)([\w.]+)/g;
  let match;
  while ((match = pattern.exec(text))) {
    const attribute = { block: match[1] === '@', name: match[2] };
    if (text[pattern.lastIndex] === '(') {
      const close = closingParenthesis(text, pattern.lastIndex);
      attribute.args = text.slice(pattern.lastIndex + 1, close);
      pattern.lastIndex = close + 1;
    }
    attributes.push(attribute);
  }
  return attributes;
}

function readArguments(text = '') {
  const positional = [];
  const named = {};
  for (const part of splitTopLevel(text)) {
    const namedMatch = /^(\w+)\s*:\s*([\s\S]*)$/.exec(part);
    if (namedMatch) named[namedMatch[1]] = namedMatch[2].trim();
    else positional.push(part);
  }
  return { positional, named };
}

function unquote(value) {
  const match = /^"((?:[^"\\]|\\.)*)"$/.exec(value?.trim() ?? '');
  return match ? match[1].replace(/\\(.)/g, '$1') : undefined;
}

function listItems(value) {
  const trimmed = value?.trim() ?? '';
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [];
  return splitTopLevel(trimmed.slice(1, -1));
}

function snakeCase(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

// `name(ops: raw("gin_trgm_ops"))`, `createdAt(sort: Desc)` or a bare field name.
function readIndexKey(item) {
  const match = /^(\w+)\s*(?:\(([\s\S]*)\))?$/.exec(item);
  if (!match) return;
  const key = { column: match[1] };
  const { named } = readArguments(match[2]);
  if (named.sort) key.direction = named.sort.toLowerCase();
  if (named.ops) {
    const raw = /^raw\(\s*("(?:[^"\\]|\\.)*")\s*\)$/.exec(named.ops);
    key.opclass = raw ? unquote(raw[1]) : snakeCase(named.ops);
  }
  return key;
}

function readPredicate(value) {
  if (!value) return;
  const raw = /^raw\(\s*("(?:[^"\\]|\\.)*")\s*\)$/.exec(value);
  return raw ? unquote(raw[1]) : value;
}

// Joins attribute arguments that continue on following lines, keeping the first line's number.
function logicalLines(text) {
  const lines = [];
  let pending;
  text.split(/\r?\n/).forEach((raw, index) => {
    const content = stripComment(raw);
    if (pending) {
      pending.text += ' ' + content.trim();
      pending.depth += depthChange(content);
    } else {
      pending = { text: content, line: index + 1, raw, depth: depthChange(content) };
    }
    if (pending.depth <= 0) {
      lines.push(pending);
      pending = undefined;
    }
  });
  if (pending) lines.push(pending);
  return lines;
}

function readBlocks(source) {
  const blocks = [];
  let current;
  for (const entry of logicalLines(source.text)) {
    const trimmed = entry.text.trim();
    if (!current) {
      const opening = /^(model|view|enum|type|datasource|generator)\s+(\w+)\s*\{\s*$/.exec(trimmed);
      if (opening) {
        const column = entry.raw.indexOf(opening[2]) + 1;
        current = { kind: opening[1], name: opening[2], file: source.file, line: entry.line, column, entries: [] };
      }
    } else if (trimmed === '}') {
      blocks.push(current);
      current = undefined;
    } else if (trimmed) {
      current.entries.push({ ...entry, text: trimmed });
    }
  }
  return blocks;
}

function readField(entry) {
  const match = /^(\w+)\s+(\w+)(\([^)]*\))?(\?|\[\])?\s*(.*)$/.exec(entry.text);
  if (!match) return;
  return {
    name: match[1],
    type: match[2],
    list: match[4] === '[]',
    attributes: readAttributes(match[5]),
    line: entry.line,
    column: entry.raw.indexOf(match[1]) + 1,
  };
}

function keysFromList(value) {
  const keys = listItems(value).map(readIndexKey);
  return keys.length && keys.every(Boolean) ? keys : undefined;
}

function blockIndex(attribute, location) {
  const { positional, named } = readArguments(attribute.args);
  const keys = keysFromList(named.fields ?? positional[0]);
  if (!keys) return;
  const method = indexMethods[(named.type ?? 'BTree').toLowerCase()];
  if (!method) return;
  return createIndex({
    name: unquote(named.map ?? named.name),
    keys,
    unique: attribute.name !== 'index',
    primary: attribute.name === 'id',
    method,
    predicate: readPredicate(named.where),
    ...location,
  });
}

function fieldColumnName(field) {
  const mapped = field.attributes.find((attribute) => attribute.name === 'map');
  return unquote(readArguments(mapped?.args).positional[0]) ?? field.name;
}

function buildModel(block, schema) {
  const fields = block.entries
    .filter((entry) => !entry.text.startsWith('@@'))
    .map(readField)
    .filter(Boolean);
  const blockAttributes = block.entries.filter((entry) => entry.text.startsWith('@@'));
  if (blockAttributes.some((entry) => /^@@ignore\b/.test(entry.text))) return;
  const mapped = blockAttributes.find((entry) => /^@@map\b/.test(entry.text));
  const tableName = mapped && unquote(readArguments(readAttributes(mapped.text)[0].args).positional[0]);
  const table = createTable({
    name: block.name,
    dbName: tableName ?? block.name,
    dialect: schema.dialect,
    file: block.file,
    line: block.line,
    column: block.column,
  });
  table.orm = 'prisma';
  const relations = [];
  for (const field of fields) {
    const isModel = !scalarTypes.has(field.type) && !schema.enums.has(field.type);
    if (isModel) {
      const relation = field.attributes.find((attribute) => attribute.name === 'relation');
      if (relation) relations.push({ type: field.type, ...readArguments(relation.args).named });
      continue;
    }
    if (field.attributes.some((attribute) => attribute.name === 'ignore')) continue;
    const type = schema.enums.has(field.type) ? 'enum' : field.list ? field.type + '[]' : field.type;
    const column = createColumn({
      name: field.name,
      dbName: fieldColumnName(field),
      type,
      file: block.file,
      line: field.line,
      column: field.column,
    });
    // `@db.Text` and friends decide how wide a String column really is.
    const nativeType = field.attributes.find((attribute) => attribute.name.startsWith('db.'));
    if (nativeType) column.nativeType = nativeType.name.slice('db.'.length);
    table.columns.set(field.name, column);
    for (const attribute of field.attributes) {
      if (attribute.name !== 'id' && attribute.name !== 'unique') continue;
      table.indexes.push(
        createIndex({
          name: unquote(readArguments(attribute.args).named.map),
          keys: [{ column: field.name }],
          unique: true,
          primary: attribute.name === 'id',
          file: block.file,
          line: field.line,
        }),
      );
    }
  }
  for (const entry of blockAttributes) {
    for (const attribute of readAttributes(entry.text)) {
      if (!['id', 'unique', 'index'].includes(attribute.name)) continue;
      const index = blockIndex(attribute, { file: block.file, line: entry.line });
      if (index) table.indexes.push(index);
    }
  }
  for (const relation of relations) {
    const fieldNames = listItems(relation.fields);
    const references = listItems(relation.references);
    fieldNames.forEach((fieldName, position) => {
      const column = table.columns.get(fieldName);
      if (column && references[position]) {
        column.foreignKey = { table: relation.type, column: references[position], position };
      }
    });
  }
  return table;
}

function parsePrismaSchema(sources) {
  const blocks = sources.flatMap(readBlocks);
  const schema = { dialect: undefined, provider: undefined, models: new Map(), views: new Set(), enums: new Set() };
  for (const block of blocks) {
    if (block.kind === 'enum') schema.enums.add(block.name);
    if (block.kind === 'view') schema.views.add(block.name);
    if (block.kind !== 'datasource') continue;
    const provider = block.entries.map((entry) => /^provider\s*=\s*("[^"]*")/.exec(entry.text)).find(Boolean);
    schema.provider = unquote(provider?.[1]);
    schema.dialect = providerDialects[schema.provider];
  }
  for (const block of blocks) {
    if (block.kind !== 'model') continue;
    const table = buildModel(block, schema);
    if (table) schema.models.set(table.name, table);
  }
  return schema;
}

function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
}

function prismaFilesIn(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.prisma'))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
    .filter((filename) => !filename.split(path.sep).includes('node_modules'))
    .sort();
}

// Prisma's own lookup order: package.json#prisma.schema, then prisma/schema.prisma, a prisma/schema folder, schema.prisma.
function findPrismaSchemaFiles(root) {
  const configured = readJson(path.join(root, 'package.json'))?.prisma?.schema;
  const candidates = [
    ...(typeof configured === 'string' ? [path.resolve(root, configured)] : []),
    path.join(root, 'prisma', 'schema.prisma'),
    path.join(root, 'prisma', 'schema'),
    path.join(root, 'schema.prisma'),
  ];
  for (const candidate of candidates) {
    const stat = fs.statSync(candidate, { throwIfNoEntry: false });
    if (stat?.isFile()) return [candidate];
    if (stat?.isDirectory()) {
      const files = prismaFilesIn(candidate);
      if (files.length) return files;
    }
  }
  return [];
}

function fileTimes(files) {
  return files.map((filename) => fs.statSync(filename, { throwIfNoEntry: false })?.mtimeMs ?? -1).join(',');
}

function loadPrismaSchema(root) {
  const cached = cache.get(root);
  const now = Date.now();
  if (cached && now - cached.checkedAt < revalidateAfterMilliseconds) return cached.schema;
  const files = findPrismaSchemaFiles(root);
  const times = fileTimes(files);
  if (cached && cached.files.join('\n') === files.join('\n') && cached.times === times) {
    cached.checkedAt = now;
    return cached.schema;
  }
  const schema = files.length
    ? parsePrismaSchema(files.map((file) => ({ file, text: fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') })))
    : undefined;
  cache.set(root, { files, times, schema, checkedAt: now });
  return schema;
}

// `index-missing-foreign-key` findings on the schema file itself, which the source scan never visits.
function checkSchemaFile(root) {
  const schema = loadPrismaSchema(root);
  if (!schema) return [];
  // Required lazily: the index rules load the TypeScript-facing helpers, which this parser does not need.
  const { foreignKeyFinding } = require('../index-rules.cjs');
  const { relativeFile } = require('./ts-helpers.cjs');
  const findings = [];
  for (const table of schema.models.values()) {
    for (const column of table.columns.values()) {
      const finding = column.foreignKey && foreignKeyFinding(table, column.name, 'prisma');
      if (!finding) continue;
      const { message, suggestion, contextualReason } = finding;
      const located = { file: relativeFile(column.file), line: column.line, column: column.column };
      findings.push({ ...located, ruleId: 'index-missing-foreign-key', message, suggestion });
      if (contextualReason) findings.at(-1).contextualReason = contextualReason;
    }
  }
  return findings;
}

module.exports = { parsePrismaSchema, findPrismaSchemaFiles, loadPrismaSchema, checkSchemaFile };
