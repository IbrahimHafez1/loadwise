import type { LocatedFinding } from './types/module-graph.js';
import type { DuplicateIndex, SourceLocation } from './types/polyglot-scan.js';

interface Grammar {
  parser: string;
  functions: string[];
  nested: string[];
  controls: string[];
  writes: string[];
  returns: string;
}

interface KindMatcher {
  kind?: string;
  any?: { kind: string }[];
}

interface ContainsMatcher {
  has: KindMatcher & { stopBy: string };
}

type RuleClause = { regex: string } | ContainsMatcher | { not: ContainsMatcher };

/** The ast-grep rule that finds function bodies worth comparing. */
interface DuplicateBodyRule {
  id: string;
  language: string;
  severity: string;
  message: string;
  rule: {
    kind: string;
    inside: KindMatcher;
    all: RuleClause[];
  };
}

const minimumCharacters = 80;
const maximumCharacters = 4096;
const minimumLineSpan = 4;
const grammars: Record<string, Grammar> = {
  Python: {
    parser: 'Python',
    functions: ['function_definition'],
    nested: ['function_definition', 'lambda', 'class_definition'],
    controls: ['if_statement', 'for_statement', 'while_statement'],
    writes: ['assignment', 'augmented_assignment'],
    returns: 'return_statement',
  },
  Go: {
    parser: 'Go',
    functions: ['function_declaration', 'method_declaration'],
    nested: ['func_literal'],
    controls: ['if_statement', 'for_statement'],
    writes: ['short_var_declaration', 'assignment_statement'],
    returns: 'return_statement',
  },
  Java: {
    parser: 'Java',
    functions: ['method_declaration'],
    nested: ['lambda_expression', 'class_body'],
    controls: ['if_statement', 'for_statement', 'enhanced_for_statement', 'while_statement'],
    writes: ['local_variable_declaration', 'assignment_expression'],
    returns: 'return_statement',
  },
  'C#': {
    parser: 'CSharp',
    functions: ['method_declaration', 'local_function_statement'],
    nested: ['lambda_expression', 'local_function_statement', 'anonymous_method_expression'],
    controls: ['if_statement', 'for_statement', 'foreach_statement', 'while_statement'],
    writes: ['local_declaration_statement', 'assignment_expression'],
    returns: 'return_statement',
  },
  Rust: {
    parser: 'Rust',
    functions: ['function_item'],
    nested: ['function_item', 'closure_expression'],
    controls: ['if_expression', 'for_expression', 'loop_expression', 'while_expression'],
    writes: ['let_declaration', 'assignment_expression'],
    returns: 'return_expression',
  },
};

function kinds(names: readonly string[]): KindMatcher {
  return names.length === 1 ? { kind: names[0] } : { any: names.map((kind) => ({ kind })) };
}

function duplicateRule(language: string): DuplicateBodyRule | undefined {
  const grammar = grammars[language];
  if (!grammar) return;
  const contains = (names: readonly string[]): ContainsMatcher => ({ has: { ...kinds(names), stopBy: 'end' } });
  return {
    id: 'duplicate-body-candidate',
    language: grammar.parser,
    severity: 'hint',
    message: 'Compare substantial function bodies.',
    rule: {
      kind: 'block',
      inside: kinds(grammar.functions),
      all: [
        { regex: `^(?s:.{${minimumCharacters},${maximumCharacters}})$` },
        { regex: '(?:[^\\n]*\\n){4}' },
        contains(grammar.controls),
        contains(grammar.writes),
        contains([grammar.returns]),
        { not: contains(grammar.nested) },
      ],
    },
  };
}

function compareLocations(first: SourceLocation, second: SourceLocation): number {
  return first.file < second.file
    ? -1
    : first.file > second.file
      ? 1
      : first.line - second.line || first.column - second.column;
}

function createDuplicateIndex(): DuplicateIndex {
  // Map confirms full string equality even on hash collisions. Each body is retained just once.
  const groups = new Map<string, SourceLocation[]>();
  return {
    add(language, file, match) {
      const body = match.text;
      const { start, end } = match.range;
      if (
        !grammars[language] ||
        !body ||
        end.line - start.line < minimumLineSpan ||
        body.length < minimumCharacters ||
        body.length > maximumCharacters * 2
      )
        return;
      // The Python block begins at the first statement token; its initial indentation is outside
      // the match.
      const prefix = language === 'Python' ? language + ':' + start.column : language;
      const key = prefix + '\0' + body;
      const location = { file, line: start.line + 1, column: start.column + 1 };
      const group = groups.get(key);
      if (group) group.push(location);
      else groups.set(key, [location]);
    },
    findings() {
      const results: LocatedFinding[] = [];
      for (const locations of groups.values()) {
        if (locations.length < 2) continue;
        const [first, ...related] = locations.slice().sort(compareLocations);
        results.push({
          ...first,
          ruleId: 'duplicate-implementation',
          message: `These ${locations.length} functions have identical body text. If they implement the same contract, extract one shared function, call it from each listed location, and test it once. Changes to one copy will otherwise miss the others. Compare input, error and boundary behavior first, since similar-looking copies can differ on purpose.`,
          related,
        });
      }
      return results.sort(compareLocations);
    },
  };
}

export { duplicateRule, createDuplicateIndex };
