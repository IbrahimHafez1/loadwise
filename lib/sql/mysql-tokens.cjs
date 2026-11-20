'use strict';

const { createPositionIndex } = require('./locations.cjs');

const DEFAULT_DELIMITER = ';';
const DELIMITER_COMMAND = /^delimiter[ \t]+(\S+)[^\n]*/i;
const WORD_CHARACTER = /[\p{L}\p{N}_$@]/u;
const COLUMN_SKIP_WORDS = new Set(['COLUMN']);
const NON_COLUMN_DROP_WORDS = new Set(['INDEX', 'KEY', 'PRIMARY', 'FOREIGN', 'CONSTRAINT', 'CHECK', 'PARTITION']);

function isLineCommentStart(text, index) {
  if (text[index] === '#') return true;
  return text[index] === '-' && text[index + 1] === '-' && (index + 2 >= text.length || /\s/.test(text[index + 2]));
}

function skipLineComment(text, index) {
  const newline = text.indexOf('\n', index);
  return newline === -1 ? text.length : newline;
}

function skipBlockComment(text, index) {
  const close = text.indexOf('*/', index + 2);
  return close === -1 ? text.length : close + 2;
}

// MySQL strings allow both doubled quotes and backslash escapes; backticks only double.
function skipQuoted(text, index, quote) {
  let cursor = index + 1;
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === '\\' && quote !== '`') cursor += 2;
    else if (character === quote) {
      if (text[cursor + 1] === quote) cursor += 2;
      else return cursor + 1;
    } else cursor += 1;
  }
  return text.length;
}

function skipTrivia(text, start, end) {
  let index = start;
  while (index < end) {
    if (/\s/.test(text[index])) index += 1;
    else if (isLineCommentStart(text, index)) index = skipLineComment(text, index);
    else if (text.startsWith('/*', index)) index = skipBlockComment(text, index);
    else break;
  }
  return Math.min(index, end);
}

function createToken(type, text, start, end, value = text.slice(start, end)) {
  return { type, value, upper: value.toUpperCase(), start, end };
}

function readQuotedToken(text, index) {
  const quote = text[index];
  const end = skipQuoted(text, index, quote);
  if (quote === '`') {
    const name = text.slice(index + 1, Math.max(index + 1, end - 1)).replaceAll('``', '`');
    return createToken('ident', text, index, end, name);
  }
  return createToken('string', text, index, end);
}

function readWordToken(text, index, end) {
  let cursor = index;
  while (cursor < end && WORD_CHARACTER.test(text[cursor])) cursor += 1;
  return createToken('word', text, index, cursor);
}

// Tokens of text[start, end): comments are dropped, positions stay absolute.
function tokenizeRange(text, start, end) {
  const tokens = [];
  let index = start;
  while (index < end) {
    const trivia = skipTrivia(text, index, end);
    if (trivia !== index) index = trivia;
    else if (/['"`]/.test(text[index])) {
      const token = readQuotedToken(text, index);
      tokens.push(token);
      index = token.end;
    } else if (WORD_CHARACTER.test(text[index])) {
      const token = readWordToken(text, index, end);
      tokens.push(token);
      index = token.end;
    } else {
      tokens.push(createToken('punct', text, index, index + 1));
      index += 1;
    }
  }
  return tokens;
}

function readDelimiterCommand(text, index) {
  const match = DELIMITER_COMMAND.exec(
    text.slice(index, text.indexOf('\n', index) === -1 ? undefined : text.indexOf('\n', index)),
  );
  return match ? { delimiter: match[1], end: index + match[0].length } : null;
}

function findStatementEnd(text, start, delimiter) {
  let index = start;
  while (index < text.length) {
    const character = text[index];
    if (text.startsWith(delimiter, index)) return index;
    if (isLineCommentStart(text, index)) index = skipLineComment(text, index);
    else if (text.startsWith('/*', index)) index = skipBlockComment(text, index);
    else if (/['"`]/.test(character)) index = skipQuoted(text, index, character);
    else index += 1;
  }
  return text.length;
}

// Statement ranges, honouring `DELIMITER xx` commands (which are not statements themselves).
function splitStatementRanges(text) {
  const ranges = [];
  let delimiter = DEFAULT_DELIMITER;
  let index = 0;
  while (index < text.length) {
    const start = skipTrivia(text, index, text.length);
    if (start >= text.length) break;
    const command = readDelimiterCommand(text, start);
    if (command) {
      delimiter = command.delimiter;
      index = command.end;
      continue;
    }
    const end = findStatementEnd(text, start, delimiter);
    ranges.push({ start, end });
    index = end + delimiter.length;
  }
  return ranges;
}

function readQualifiedName(tokens, position) {
  const parts = [];
  let cursor = position;
  while (isNameToken(tokens[cursor])) {
    parts.push(tokens[cursor].value);
    if (tokens[cursor + 1]?.value === '.' && isNameToken(tokens[cursor + 2])) cursor += 2;
    else {
      cursor += 1;
      break;
    }
  }
  if (parts.length === 0) return null;
  return { table: parts.at(-1), schema: parts.length > 1 ? parts.at(-2) : null, next: cursor };
}

function isNameToken(token) {
  return token !== undefined && (token.type === 'ident' || token.type === 'word');
}

function skipWords(tokens, position, words) {
  let cursor = position;
  while (tokens[cursor] && tokens[cursor].type === 'word' && words.has(tokens[cursor].upper)) cursor += 1;
  return cursor;
}

// Position after an `IF EXISTS` / `IF NOT EXISTS` clause starting at `position`, else `position`.
function skipIfClause(tokens, position) {
  if (tokens[position]?.upper !== 'IF') return position;
  const existsAt = tokens[position + 1]?.upper === 'NOT' ? position + 2 : position + 1;
  return tokens[existsAt]?.upper === 'EXISTS' ? existsAt + 1 : position;
}

function skipColumnKeywords(tokens, position) {
  return skipIfClause(tokens, skipWords(tokens, position, COLUMN_SKIP_WORDS));
}

function readOptionValue(tokens, optionName) {
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].type !== 'word' || tokens[index].upper !== optionName) continue;
    const valueIndex = tokens[index + 1]?.value === '=' ? index + 2 : index + 1;
    if (tokens[valueIndex]) return tokens[valueIndex].upper;
  }
  return null;
}

function splitTopLevelCommas(tokens) {
  const groups = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token.value === '(') depth += 1;
    else if (token.value === ')') depth -= 1;
    if (token.value === ',' && depth === 0) groups.push([]);
    else groups.at(-1).push(token);
  }
  return groups.filter((group) => group.length > 0);
}

function hasWordSequence(tokens, ...words) {
  return tokens.some((_, index) => words.every((word, offset) => tokens[index + offset]?.upper === word));
}

function describeAddColumn(tokens, position) {
  const name = tokens[skipColumnKeywords(tokens, position)];
  const rest = tokens.slice(position);
  return {
    type: 'add-column',
    column: name?.value ?? null,
    notNull: hasWordSequence(rest, 'NOT', 'NULL'),
    hasDefault: hasWordSequence(rest, 'DEFAULT'),
  };
}

function describeAdd(tokens) {
  const afterAdd = 1;
  const next = tokens[afterAdd]?.upper;
  const afterUnique = tokens[afterAdd + 1]?.upper;
  if (['INDEX', 'KEY', 'FULLTEXT', 'SPATIAL'].includes(next)) return { type: 'add-index', unique: false };
  if (next === 'UNIQUE' && ['INDEX', 'KEY', undefined].includes(afterUnique))
    return { type: 'add-index', unique: true };
  if (['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'PARTITION'].includes(next)) {
    return { type: 'add-constraint', primaryKey: next === 'PRIMARY' };
  }
  return describeAddColumn(tokens, afterAdd);
}

function describeDrop(tokens) {
  const next = tokens[1]?.upper;
  if (next === 'PRIMARY') return { type: 'drop-primary-key' };
  if (next === 'INDEX' || next === 'KEY')
    return { type: 'drop-index', index: tokens[skipIfClause(tokens, 2)]?.value ?? null };
  if (NON_COLUMN_DROP_WORDS.has(next)) return { type: 'drop-constraint' };
  const name = tokens[skipColumnKeywords(tokens, 1)];
  return { type: 'drop-column', column: name?.value ?? null };
}

function describeRename(tokens) {
  const next = tokens[1]?.upper;
  if (next === 'COLUMN') {
    const column = skipIfClause(tokens, 2);
    return { type: 'rename-column', column: tokens[column]?.value ?? null, newName: tokens[column + 2]?.value ?? null };
  }
  if (next === 'INDEX' || next === 'KEY') return { type: 'rename-index' };
  const nameStart = ['TO', 'AS'].includes(next) ? 2 : 1;
  return { type: 'rename-table', newName: tokens[nameStart]?.value ?? null };
}

function describeAlterAction(tokens) {
  const keyword = tokens[0].upper;
  const afterKeyword = skipColumnKeywords(tokens, 1);
  if (keyword === 'ADD') return describeAdd(tokens);
  if (keyword === 'DROP') return describeDrop(tokens);
  if (keyword === 'MODIFY') return { type: 'modify-column', column: tokens[afterKeyword]?.value ?? null };
  if (keyword === 'CHANGE') {
    return {
      type: 'change-column',
      column: tokens[afterKeyword]?.value ?? null,
      newName: tokens[afterKeyword + 1]?.value ?? null,
    };
  }
  if (keyword === 'RENAME') return describeRename(tokens);
  if (keyword === 'CONVERT' && tokens[1]?.upper === 'TO') return { type: 'convert-charset' };
  return { type: 'other' };
}

function isStatementOption(actionTokens) {
  return ['ALGORITHM', 'LOCK'].includes(actionTokens[0].upper);
}

function recognizeAlterTable(tokens) {
  const position = skipWords(tokens, 1, new Set(['ONLINE', 'IGNORE']));
  if (tokens[position]?.upper !== 'TABLE') return null;
  const name = readQualifiedName(tokens, skipIfClause(tokens, position + 1));
  if (!name) return null;
  const actionGroups = splitTopLevelCommas(tokens.slice(name.next)).filter((group) => !isStatementOption(group));
  return {
    kind: 'alter-table',
    table: name.table,
    schema: name.schema,
    actions: actionGroups.map(describeAlterAction),
    algorithm: readOptionValue(tokens, 'ALGORITHM'),
    lock: readOptionValue(tokens, 'LOCK'),
  };
}

function recognizeCreateIndex(tokens) {
  let position = 1;
  const modifiers = [];
  while (['UNIQUE', 'FULLTEXT', 'SPATIAL', 'ONLINE'].includes(tokens[position]?.upper)) {
    modifiers.push(tokens[position].upper);
    position += 1;
  }
  if (tokens[position]?.upper !== 'INDEX') return null;
  const index = tokens[skipIfClause(tokens, position + 1)]?.value ?? null;
  const onPosition = tokens.findIndex((token, tokenIndex) => tokenIndex > position && token.upper === 'ON');
  const name = onPosition === -1 ? null : readQualifiedName(tokens, onPosition + 1);
  if (!name) return null;
  return {
    kind: 'create-index',
    index,
    table: name.table,
    schema: name.schema,
    unique: modifiers.includes('UNIQUE'),
    algorithm: readOptionValue(tokens, 'ALGORITHM'),
    lock: readOptionValue(tokens, 'LOCK'),
  };
}

function readNameList(tokens, position) {
  const names = [];
  let cursor = position;
  while (true) {
    const name = readQualifiedName(tokens, cursor);
    if (!name) break;
    names.push({ table: name.table, schema: name.schema });
    cursor = name.next;
    if (tokens[cursor]?.value !== ',') break;
    cursor += 1;
  }
  return names;
}

function recognizeDrop(tokens) {
  const target = tokens[1]?.upper === 'TEMPORARY' ? 2 : 1;
  if (tokens[target]?.upper === 'TABLE') {
    return { kind: 'drop-table', tables: readNameList(tokens, skipIfClause(tokens, target + 1)) };
  }
  if (tokens[target]?.upper === 'INDEX') {
    const onPosition = tokens.findIndex((token) => token.upper === 'ON');
    const name = onPosition === -1 ? null : readQualifiedName(tokens, onPosition + 1);
    if (!name) return null;
    return {
      kind: 'drop-index',
      index: tokens[skipIfClause(tokens, target + 1)]?.value ?? null,
      table: name.table,
      schema: name.schema,
      algorithm: readOptionValue(tokens, 'ALGORITHM'),
      lock: readOptionValue(tokens, 'LOCK'),
    };
  }
  return null;
}

function recognizeRenameTable(tokens) {
  if (tokens[1]?.upper !== 'TABLE') return null;
  const renames = [];
  let cursor = 2;
  while (true) {
    const from = readQualifiedName(tokens, cursor);
    if (!from || tokens[from.next]?.upper !== 'TO') break;
    const to = readQualifiedName(tokens, from.next + 1);
    if (!to) break;
    renames.push({ from: { table: from.table, schema: from.schema }, to: { table: to.table, schema: to.schema } });
    cursor = to.next;
    if (tokens[cursor]?.value !== ',') break;
    cursor += 1;
  }
  return renames.length > 0 ? { kind: 'rename-table', renames } : null;
}

const RECOGNIZERS = {
  ALTER: recognizeAlterTable,
  CREATE: recognizeCreateIndex,
  DROP: recognizeDrop,
  RENAME: recognizeRenameTable,
};

function recognizeStatement(tokens) {
  const recognizer = tokens.length > 0 ? RECOGNIZERS[tokens[0].upper] : undefined;
  // Anything the recognizers do not fully understand stays 'other' rather than being guessed.
  return recognizer?.(tokens) ?? { kind: 'other' };
}

function parseMysqlStatements(text) {
  const index = createPositionIndex(text);
  return splitStatementRanges(text).map((range) => {
    const tokens = tokenizeRange(text, range.start, range.end);
    const begin = index.fromCharOffset(range.start);
    return {
      ...recognizeStatement(tokens),
      start: range.start,
      end: range.end,
      line: begin.line,
      column: begin.column,
      text: text.slice(range.start, range.end),
    };
  });
}

module.exports = { parseMysqlStatements, splitStatementRanges, tokenizeRange };
