'use strict';

const maxStatementLength = 360;
const maxFilterLines = 6;
const existenceMethods = { findOne: 'exists', findOneBy: 'existsBy' };

function filterSuffix(document, row, indentation) {
  let suffix = '';
  for (let offset = 1; offset <= maxFilterLines && row + offset < document.lineCount; offset++) {
    const next = document.lineAt(row + offset).text;
    if (next.length > maxStatementLength || !next.startsWith(indentation)) return;
    const text = next.slice(indentation.length);
    suffix += '\n' + text;
    if (/^\}\s*\)/.test(text)) return suffix;
  }
}

function existenceComparison(document, line, position) {
  const column = position.character;
  if (line[column - 1] !== '.') return;
  const method = /^(findOneBy|findOne)(?=\s*\()/.exec(line.slice(column, column + 32))?.[1];
  if (!method) return;
  const replacement = existenceMethods[method];
  const receiver = /[$\w.]+$/.exec(line.slice(Math.max(0, column - 42), column - 1))?.[0];
  const prefix = receiver && receiver.length <= 40 ? receiver + '.' : '';
  const readableLine = line.length <= maxStatementLength && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(line.trim());
  const suffix =
    readableLine && /\(\s*\{\s*$/.test(line) ? filterSuffix(document, position.line, /^\s*/.exec(line)[0]) : '';
  const excerpt = readableLine && suffix !== undefined;
  return {
    before: excerpt ? line.trim() + suffix : prefix + method + '(…)',
    code: excerpt
      ? (line.slice(0, column) + replacement + line.slice(column + method.length)).trim() + suffix
      : prefix + replacement + '(…)',
    inline: `${prefix}${method}(…) → ${prefix}${replacement}(…)`,
    note: 'Keep the original filters and condition. The existence query returns a boolean and skips entity hydration. Check whether the entity has load hooks with side effects.',
  };
}

// Limit source rewrites to standalone calls with simple, balanced arguments. A trailing chain or another
// statement needs a placement decision for await, and numeric descriptors need a different async API.
function simplePathCall(argumentsText) {
  const masked = argumentsText.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, 'string');
  if (!/^\(\s*[A-Za-z_$][\w$.,()[\]\s]*\)$/.test(masked)) return false;
  let depth = 0;
  for (let index = 0; index < masked.length; index++) {
    if (masked[index] === '(') depth++;
    if (masked[index] === ')' && --depth === 0) return index === masked.length - 1;
  }
  return false;
}

function filesystemComparison(line, diagnostic) {
  const column = diagnostic.range.start.character;
  const operation = /\bfs\.(writeFile|appendFile|readFile)Sync\b/.exec(diagnostic.message ?? '')?.[1];
  if (!operation || line.length > maxStatementLength) return;
  const call = /^(?:([$A-Z_a-z][$\w]*)\.)?([$A-Z_a-z][$\w]*)\s*(\(.*\));\s*$/.exec(line.slice(column));
  if (!call || call[2] !== operation + 'Sync' || !simplePathCall(call[3])) return;
  const prefix = line.slice(0, column).trimStart();
  if (prefix && !/^(?:return\s+|(?:const|let)\s+[$A-Z_a-z][$\w]*\s*=\s*)$/.test(prefix)) return;
  const syncCall = call[1] ? call[1] + '.' + call[2] : call[2];
  const asyncCall = call[1] ? call[1] + '.promises.' + operation : operation;
  const importNote = call[1]
    ? ''
    : `Import ${operation} from node:fs/promises at module scope, aliasing it if needed. `;
  return {
    code: prefix + 'await ' + asyncCall + call[3] + ';',
    inline: `${syncCall}(…) → await ${asyncCall}(…)`,
    note:
      importNote +
      'This rewrite accepts a path or URL. For an existing numeric file descriptor, use the callback API. Keep the operation inside the original error handler.',
  };
}

function perfSiteComparison(document, line, diagnostic) {
  if (diagnostic.code === 'typeorm-existence-materialization')
    return existenceComparison(document, line, diagnostic.range.start);
  if (diagnostic.code === 'node-sync-fs-in-async') return filesystemComparison(line, diagnostic);
}

module.exports = { perfSiteComparison };
