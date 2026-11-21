'use strict';

// `// loadwise-reviewed <rule-id> -- <reason>` on the line above a finding records a human review: the finding
// becomes contextual with that reason. Declared contracts cannot be dismissed this way.
// The older `warden-reviewed`, `maintainability-reviewed` and `backend-perf-reviewed` spellings stay accepted so existing comments keep working.
const fs = require('node:fs');
const path = require('node:path');

const directive =
  /^[\t ]*\/\/[\t ]+(?:loadwise|warden|maintainability|backend-perf)-reviewed[\t ]+([a-z][a-z0-9-]*)[\t ]+--[\t ]+(\S[^\r\n]*?)[\t ]*$/;
const protectedRules = new Set(['file-placement', 'folder-boundary', 'data-access-boundary', 'query-mutates-state']);
const scriptKinds = { '.ts': 3, '.mts': 3, '.cts': 3, '.tsx': 4, '.js': 1, '.cjs': 1, '.mjs': 1, '.jsx': 2 };

function supportsReviewDirective(finding) {
  return !protectedRules.has(finding.ruleId) && Object.hasOwn(scriptKinds, path.extname(finding.file).toLowerCase());
}

// Template text, JSX and block comments can look like a directive; only a real line comment in a token's leading
// trivia counts.
function isLineComment(sourceFile, offset) {
  const ts = require('typescript');
  let found = false;
  (function visit(node) {
    if (found || offset < node.pos || offset >= node.end) return;
    if (offset < node.getStart(sourceFile)) {
      found = Boolean(
        ts
          .getLeadingCommentRanges(sourceFile.text, node.pos)
          ?.some((range) => range.pos === offset && range.kind === ts.SyntaxKind.SingleLineCommentTrivia),
      );
      return;
    }
    ts.forEachChild(node, visit);
  })(sourceFile);
  return found;
}

function createSourceLoader(root) {
  const files = new Map();
  return function load(file) {
    if (files.has(file)) return files.get(file);
    let entry;
    const scriptKind = scriptKinds[path.extname(file).toLowerCase()];
    try {
      if (scriptKind !== undefined) {
        const text = fs.readFileSync(path.resolve(root, file), 'utf8').replace(/^\uFEFF/, '');
        entry = { text, lines: text.split('\n'), scriptKind };
      }
    } catch {
      entry = undefined;
    }
    files.set(file, entry);
    return entry;
  };
}

function applyReviewDirectives(findings, root) {
  const load = createSourceLoader(root);
  for (const finding of findings) {
    if (!supportsReviewDirective(finding) || !(finding.line > 1)) continue;
    const entry = load(finding.file);
    const previous = entry?.lines[finding.line - 2]?.replace(/\r$/, '');
    const match = previous && directive.exec(previous);
    if (!match || match[1] !== finding.ruleId) continue;
    if (!entry.sourceFile) {
      const ts = require('typescript');
      entry.sourceFile = ts.createSourceFile(finding.file, entry.text, ts.ScriptTarget.Latest, true, entry.scriptKind);
    }
    const lineStart = entry.lines.slice(0, finding.line - 2).reduce((total, line) => total + line.length + 1, 0);
    if (isLineComment(entry.sourceFile, lineStart + previous.indexOf('//')))
      finding.contextualReason = 'Reviewed in source: ' + match[2];
  }
}

module.exports = { applyReviewDirectives, supportsReviewDirective };
