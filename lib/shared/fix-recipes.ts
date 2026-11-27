import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { errorMessage } from './error-code.js';
import { isRecord } from './is-record.js';
import type { Finding, FixChange } from './types.js';

interface RecipeInput {
  finding: Finding;
  source: string;
}

/** A user's fix recipe; it returns replacements, or null to leave the finding manual. */
type RecipeHandler = (input: RecipeInput) => unknown;

type FixRecipes = Record<string, RecipeHandler>;

interface RecipeSource {
  source: string;
  lines: string[];
}

function isRecipeHandler(value: unknown): value is RecipeHandler {
  return typeof value === 'function';
}

// Narrows only the shape of the module's export; loadRecipes checks every handler right after.
function isRecipeObject(value: unknown): value is FixRecipes {
  return typeof value === 'object' && value !== null && [null, Object.prototype].includes(Object.getPrototypeOf(value));
}

const loadCjs = createRequire(import.meta.url);

function loadRecipes(filename: string, directory: string): FixRecipes {
  const file = path.resolve(directory, filename);
  if (path.extname(file) !== '.cjs' || !fs.statSync(file).isFile()) {
    throw new Error('A fix recipe must be an explicitly named .cjs file.');
  }
  const recipes: unknown = loadCjs(file);
  if (!isRecipeObject(recipes)) {
    throw new Error('Export an object mapping checker/rule-id keys to fix recipe functions.');
  }
  for (const [key, handler] of Object.entries(recipes)) {
    if (!/^(perf|rel|maint|sec|a11y)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) || !isRecipeHandler(handler)) {
      throw new Error(`Invalid fix recipe "${key}". Expected a checker/rule-id key and a function.`);
    }
  }
  return recipes;
}

function readSource(file: string, directory: string, root: string): RecipeSource {
  const target = fs.realpathSync.native(path.resolve(directory, file));
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error(`Recipe target is outside the current project: ${file}`);
  }
  if (!fs.statSync(target).isFile()) throw new Error(`Recipe target must be a source file: ${file}`);
  const source = fs.readFileSync(target, 'utf8');
  return { source, lines: source.split(/\r?\n/) };
}

function recipeChanges(replacements: unknown, lines: readonly string[], file: string): FixChange[] {
  if (!Array.isArray(replacements) || !replacements.length) {
    throw new Error('Return a nonempty array of replacements or null to leave the finding manual.');
  }
  const changes: FixChange[] = [];
  for (const replacement of replacements) {
    if (!isRecord(replacement) || Object.keys(replacement).some((key) => !['line', 'before', 'after'].includes(key))) {
      throw new Error('Each replacement accepts only line, before and after.');
    }
    const { line, before, after } = replacement;
    if (
      typeof line !== 'number' ||
      !Number.isSafeInteger(line) ||
      line < 1 ||
      typeof before !== 'string' ||
      !before ||
      typeof after !== 'string'
    ) {
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

async function attachRecipeFixes(findings: Finding[], filename: string, directory: string): Promise<Finding[]> {
  const recipes = loadRecipes(filename, directory);
  const root = fs.realpathSync.native(directory);
  const sources = new Map<string, RecipeSource>();
  const result: Finding[] = [];
  for (const finding of findings) {
    const key = `${finding.checker}/${finding.ruleId}`;
    if (finding.fix || !Object.hasOwn(recipes, key) || !finding.file) {
      result.push(finding);
      continue;
    }
    try {
      const file = finding.file;
      let loaded = sources.get(file);
      if (!loaded) {
        loaded = readSource(file, directory, root);
        sources.set(file, loaded);
      }
      const { source, lines } = loaded;
      const replacements = await recipes[key]({ finding: structuredClone(finding), source });
      if (replacements == null) result.push(finding);
      else {
        const changes = recipeChanges(replacements, lines, file);
        result.push({ ...finding, fixable: true, fix: { requiresReview: true, changes } });
      }
    } catch (error) {
      throw new Error(`Fix recipe ${key} (#${finding.id}): ${errorMessage(error)}`, { cause: error });
    }
  }
  return result;
}

export { attachRecipeFixes };
