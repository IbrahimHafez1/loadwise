'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadRecipes(filename, directory) {
  const file = path.resolve(directory, filename);
  if (path.extname(file) !== '.cjs' || !fs.statSync(file).isFile()) {
    throw new Error('A fix recipe must be an explicitly named .cjs file.');
  }
  const recipes = require(file);
  if (!recipes || typeof recipes !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(recipes))) {
    throw new Error('Export an object mapping checker/rule-id keys to fix recipe functions.');
  }
  for (const [key, handler] of Object.entries(recipes)) {
    if (!/^(perf|maint|sec)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) || typeof handler !== 'function') {
      throw new Error(`Invalid fix recipe "${key}". Expected a checker/rule-id key and a function.`);
    }
  }
  return recipes;
}

function readSource(file, directory, root) {
  const target = fs.realpathSync.native(path.resolve(directory, file));
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error(`Recipe target is outside the current project: ${file}`);
  }
  if (!fs.statSync(target).isFile()) throw new Error(`Recipe target must be a source file: ${file}`);
  const source = fs.readFileSync(target, 'utf8');
  return { source, lines: source.split(/\r?\n/) };
}

function recipeChanges(replacements, lines, file) {
  if (!Array.isArray(replacements) || !replacements.length) {
    throw new Error('Return a nonempty array of replacements or null to leave the finding manual.');
  }
  const changes = [];
  for (const replacement of replacements) {
    if (!replacement || Object.keys(replacement).some((key) => !['line', 'before', 'after'].includes(key))) {
      throw new Error('Each replacement accepts only line, before and after.');
    }
    const { line, before, after } = replacement;
    if (!Number.isSafeInteger(line) || line < 1 || typeof before !== 'string' || !before || typeof after !== 'string') {
      throw new Error('Each replacement needs a positive line, nonempty before text and string after text.');
    }
    const original = before.replaceAll('\r\n', '\n');
    const updated = after.replaceAll('\r\n', '\n');
    if (original === updated || !original.split('\n').every((row, index) => lines[line - 1 + index] === row)) {
      throw new Error(`Expected an edit matching complete source lines at ${file}:${line}.`);
    }
    changes.push({ file, line, before: original, after: updated });
  }
  return changes;
}

async function attachRecipeFixes(findings, filename, directory) {
  const recipes = loadRecipes(filename, directory);
  const root = fs.realpathSync.native(directory);
  const sources = new Map();
  const result = [];
  for (const finding of findings) {
    const key = `${finding.checker}/${finding.ruleId}`;
    if (finding.fix || !Object.hasOwn(recipes, key) || !finding.file) {
      result.push(finding);
      continue;
    }
    try {
      const file = finding.file;
      if (!sources.has(file)) sources.set(file, readSource(file, directory, root));
      const { source, lines } = sources.get(file);
      const replacements = await recipes[key]({ finding: structuredClone(finding), source });
      if (replacements == null) result.push(finding);
      else {
        const changes = recipeChanges(replacements, lines, file);
        result.push({ ...finding, fixable: true, fix: { requiresReview: true, changes } });
      }
    } catch (error) {
      throw new Error(`Fix recipe ${key} (#${finding.id}): ${error?.message ?? error}`, { cause: error });
    }
  }
  return result;
}

module.exports = { attachRecipeFixes };
