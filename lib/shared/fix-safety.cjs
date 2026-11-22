'use strict';

// Safety net for every generated fix: the new text of a JavaScript or TypeScript file must not parse worse than the
// original did. A builder bug that leaves a stray token then refuses that file instead of breaking the project.

const javaScriptFile = /\.[cm]?[jt]sx?$/i;

// Syntax messages of the file, parsed as its extension says (.tsx and .jsx included). Other files have none.
function syntaxMessages(file, text) {
  if (!javaScriptFile.test(file) || text === undefined) return [];
  const ts = require('typescript');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  return source.parseDiagnostics.map((diagnostic) => {
    const { line } = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    return `${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')} at line ${line + 1}`;
  });
}

// Line numbers move with every edit, so diagnostics are compared by message text and count.
function messageText(message) {
  return message.replace(/ at line \d+$/, '');
}

// Returns the first syntax error `after` has beyond those already in `before`, or undefined.
function introducedSyntaxError(file, before, after) {
  const remaining = new Map();
  for (const message of syntaxMessages(file, before)) {
    const key = messageText(message);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  for (const message of syntaxMessages(file, after)) {
    const key = messageText(message);
    if (!remaining.get(key)) return message;
    remaining.set(key, remaining.get(key) - 1);
  }
}

function refusalReason(file, syntaxError) {
  return `${file}: the fix would introduce a syntax error (${syntaxError}), so the file was not changed`;
}

// Runs `applyFix` but holds its writes back until every file has passed the syntax check, so a refused fix writes
// nothing. `readFile`/`writeFile` are the accessors the checker's applyFix takes.
function applyFixSafely(applyFix, fix, { readFile, writeFile }, ...options) {
  const originals = new Map();
  const pending = [];
  const result = applyFix(
    fix,
    {
      readFile(file) {
        const text = readFile(file);
        originals.set(file, text);
        return text;
      },
      writeFile: (file, text) => pending.push([file, text]),
    },
    ...options,
  );
  if (result.error) return result;
  for (const [file, text] of pending) {
    const syntaxError = introducedSyntaxError(file, originals.get(file), text);
    if (syntaxError) return { error: refusalReason(file, syntaxError) };
  }
  for (const [file, text] of pending) writeFile(file, text);
  return result;
}

module.exports = { applyFixSafely, introducedSyntaxError, refusalReason };
