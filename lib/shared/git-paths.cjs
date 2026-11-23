// @ts-check
'use strict';

const quotedEscapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

// Git C-quotes a path holding `"`, `\` or control characters even with core.quotepath=false; octal escapes are
// UTF-8 bytes.
function unquoteGitPath(name) {
  if (!name.startsWith('"')) return name;
  const bytes = [];
  const body = name.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== '\\') {
      const codePoint = body.codePointAt(index);
      const ch = String.fromCodePoint(codePoint);
      bytes.push(...Buffer.from(ch, 'utf8'));
      if (ch.length === 2) index += 1;
    } else if (/[0-7]{3}/.test(body.slice(index + 1, index + 4))) {
      bytes.push(parseInt(body.slice(index + 1, index + 4), 8));
      index += 3;
    } else if (index + 1 < body.length) {
      bytes.push(quotedEscapes[body[index + 1]] ?? body.charCodeAt(index + 1));
      index += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

module.exports = { unquoteGitPath };
