import { duplicateRule } from '../../lib/maintainability/polyglot-duplicates.cjs';
import { csharpCandidate } from '../../lib/shared/polyglot-compatibility.cjs';

// An ast-grep rule object, restricted to the members these rules use.
interface RuleMatcher {
  kind?: string;
  any?: RuleMatcher[];
  has?: RuleMatcher;
  inside?: RuleMatcher;
  matches?: string;
  not?: RuleMatcher;
  stopBy?: RuleMatcher;
}

interface LanguageRules {
  parser: string;
  extensions: string[];
  controls: string[];
  bodies: string[];
  boundaries: string[];
}

interface RulesOptions {
  includeDuplicates?: boolean;
}

type LanguageEntry = [
  name: string,
  parser: string,
  extensions: string[],
  controls: string[],
  bodies: string[],
  boundaries: string[],
];

// Controls count only through their own statement bodies. This keeps chained alternatives and
// callback scopes distinct.
const languages: LanguageEntry[] = [
  [
    'Python',
    'Python',
    ['.py'],
    ['if_statement', 'for_statement', 'while_statement'],
    ['block'],
    ['function_definition', 'lambda', 'class_definition'],
  ],
  [
    'Go',
    'Go',
    ['.go'],
    ['if_statement', 'for_statement'],
    ['block'],
    ['function_declaration', 'method_declaration', 'func_literal'],
  ],
  [
    'Java',
    'Java',
    ['.java'],
    ['if_statement', 'for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement'],
    ['block'],
    ['method_declaration', 'constructor_declaration', 'lambda_expression', 'class_body'],
  ],
  [
    'C#',
    'CSharp',
    ['.cs'],
    ['if_statement', 'for_statement', 'foreach_statement', 'while_statement', 'do_statement'],
    ['block'],
    [
      'method_declaration',
      'constructor_declaration',
      'local_function_statement',
      'lambda_expression',
      'anonymous_method_expression',
    ],
  ],
  [
    'Rust',
    'Rust',
    ['.rs'],
    ['if_expression', 'for_expression', 'loop_expression', 'while_expression'],
    ['block'],
    ['function_item', 'closure_expression'],
  ],
  [
    'PHP',
    'Php',
    ['.php'],
    ['if_statement', 'for_statement', 'foreach_statement', 'while_statement', 'do_statement'],
    ['compound_statement'],
    ['function_definition', 'method_declaration', 'anonymous_function', 'arrow_function'],
  ],
  [
    'Ruby',
    'Ruby',
    ['.rb'],
    ['if', 'elsif', 'unless', 'for', 'while', 'until'],
    ['then', 'do', 'else'],
    ['method', 'singleton_method', 'lambda', 'block', 'do_block'],
  ],
  [
    'Kotlin',
    'Kotlin',
    ['.kt', '.kts'],
    ['if_expression', 'for_statement', 'while_statement', 'do_while_statement'],
    ['control_structure_body'],
    ['function_declaration', 'anonymous_function', 'lambda_literal'],
  ],
  [
    'C',
    'C',
    ['.c', '.h'],
    ['if_statement', 'for_statement', 'while_statement', 'do_statement'],
    ['compound_statement'],
    ['function_definition'],
  ],
  [
    'C++',
    'Cpp',
    ['.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'],
    ['if_statement', 'for_statement', 'for_range_loop', 'while_statement', 'do_statement'],
    ['compound_statement'],
    ['function_definition', 'lambda_expression'],
  ],
];

const byLanguage = new Map<string, LanguageRules>(
  languages.map(([name, parser, extensions, controls, bodies, boundaries]): [string, LanguageRules] => [
    name,
    { parser, extensions, controls, bodies, boundaries },
  ]),
);
const nonJsLanguages: Record<string, string> = Object.fromEntries(
  languages.flatMap(([name, , extensions]) => extensions.map((extension): [string, string] => [extension, name])),
);
const alternativeBodies: Record<string, string[]> = {
  Python: ['else_clause', 'elif_clause'],
  PHP: ['else_clause', 'else_if_clause'],
  Rust: ['else_clause'],
  C: ['else_clause'],
  'C++': ['else_clause'],
};

function kinds(names: readonly string[]): RuleMatcher {
  return names.length === 1 ? { kind: names[0] } : { any: names.map((kind) => ({ kind })) };
}

function rulesFor(language: string, { includeDuplicates = true }: RulesOptions = {}): string {
  const languageRules = byLanguage.get(language);
  if (!languageRules) throw new Error(`Unsupported language ${language}`);
  const { parser, controls, bodies, boundaries } = languageRules;
  const block = kinds(bodies);
  if (language === 'Kotlin') block.has = { kind: 'statements' };
  function ownedBody(owner: string): RuleMatcher {
    const relation = { matches: owner };
    const wrappers = alternativeBodies[language];
    if (!wrappers) return { ...block, inside: relation };
    return { ...block, any: [{ inside: relation }, { inside: { ...kinds(wrappers), inside: relation } }] };
  }
  const utils: Record<string, RuleMatcher> = {
    control: kinds(controls),
    body: ownedBody('control'),
    boundary: { any: [kinds(boundaries), { matches: 'body' }] },
  };
  let previous = 'control';
  for (let depth = 2; depth <= 5; depth++) {
    utils['level' + depth] = {
      matches: 'control',
      inside: {
        ...ownedBody(previous),
        stopBy: { matches: 'boundary' },
      },
    };
    previous = 'level' + depth;
  }
  const diagnostic = {
    id: 'deep-control-flow',
    language: parser,
    severity: 'warning',
    utils,
    rule: { matches: 'level4', not: { matches: 'level5' } },
    message:
      'Four nested conditionals or loops share this execution scope. Deep nesting hides which conditions lead to the code. Invert the outer condition into an early `continue` or `return` (a guard clause), or extract the inner block into a named function. Keep side effects and cleanup on both paths.',
  };
  const parseError = {
    id: 'syntax-error',
    language: parser,
    severity: 'warning',
    rule: { kind: 'ERROR' },
    message: 'The parser encountered invalid or unsupported syntax.',
  };
  return [diagnostic, parseError, includeDuplicates && duplicateRule(language), parser === 'CSharp' && csharpCandidate]
    .filter(Boolean)
    .map((rule) => JSON.stringify(rule))
    .join('\n---\n');
}

export { byLanguage, nonJsLanguages, rulesFor };
