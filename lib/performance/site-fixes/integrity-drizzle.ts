// Site fixes for the Drizzle integrity rules: the builder chain helpers and the scope and
// write-filter rewrites.
import { ts, textOf, nameTaken, isPlainReference } from './helpers.js';
import { eolOf } from './integrity-wrap.js';
import type { CallExpression, NamedImports, Node, SourceFile } from 'typescript';
import type { Finding, FixResult, SiteFixInput, TextEdit } from '../../shared/types.js';

// One call of a builder chain, such as `.where(...)`.
interface ChainStep {
  name: string;
  call: CallExpression;
}

// The builder chain that starts at the reported `db.select` / `db.update` / `db.delete`.
interface DrizzleChain {
  operation: string;
  rootCall: CallExpression;
  steps: ChainStep[];
}

interface DrizzleImports {
  local: Record<string, string>;
  edits: TextEdit[];
}

// Local names for drizzle-orm exports, plus the edits that import the missing ones.
function drizzleImports(sourceFile: SourceFile, names: readonly string[]): DrizzleImports | undefined {
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  const importedBindings = imports
    .flatMap((statement): NamedImports[] => {
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      const fromDrizzle =
        ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === 'drizzle-orm';
      return fromDrizzle && clause && !clause.isTypeOnly && bindings && ts.isNamedImports(bindings) ? [bindings] : [];
    })
    .at(0);
  const elements = importedBindings?.elements ?? [];
  const local: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    const element = elements.find(
      (candidate) => !candidate.isTypeOnly && (candidate.propertyName ?? candidate.name).text === name,
    );
    if (element) local[name] = element.name.text;
    else if (nameTaken(sourceFile, name)) return;
    else {
      local[name] = name;
      missing.push(name);
    }
  }
  if (!missing.length) return { local, edits: [] };
  if (elements.length) {
    const position = elements[elements.length - 1].end;
    return { local, edits: [{ start: position, end: position, text: ', ' + missing.join(', ') }] };
  }
  if (importedBindings) {
    return {
      local,
      edits: [{ start: importedBindings.getStart(), end: importedBindings.end, text: `{ ${missing.join(', ')} }` }],
    };
  }
  const text = sourceFile.text;
  const quote = imports[0]?.moduleSpecifier.getText().startsWith('"') ? '"' : "'";
  const line = `import { ${missing.join(', ')} } from ${quote}drizzle-orm${quote};`;
  const last = imports.at(-1);
  if (last) return { local, edits: [{ start: last.end, end: last.end, text: eolOf(text) + line }] };
  return { local, edits: [{ start: 0, end: 0, text: line + eolOf(text) }] };
}

function drizzleChain(node: Node): DrizzleChain | undefined {
  if (!ts.isIdentifier(node)) return;
  const rootAccess = node.parent;
  const rootCall = rootAccess.parent;
  if (
    !ts.isPropertyAccessExpression(rootAccess) ||
    !ts.isCallExpression(rootCall) ||
    rootCall.expression !== rootAccess
  )
    return;
  const steps: ChainStep[] = [];
  for (let current: CallExpression = rootCall; ;) {
    const access = current.parent;
    const call = access.parent;
    if (!ts.isPropertyAccessExpression(access) || !ts.isCallExpression(call) || call.expression !== access) break;
    steps.push({ name: access.name.text, call });
    current = call;
  }
  return { operation: node.text, rootCall, steps };
}
// ---- drizzle-scope-unverified ----

// What a scope fix needs from the chain: the verified column, where `.where()` goes, the table and
// the existing `.where()` step, if any.
interface ScopeTarget {
  field: string;
  anchor: CallExpression;
  table: Node;
  where: ChainStep | undefined;
}

function verifiedScopeField(finding: Finding): string | undefined {
  const column = /using eq\(([^,]+), <authorized scope>\)\.$/.exec(finding.message)?.[1];
  const field = column ? /^[^.[]+\.([A-Za-z_$][\w$]*)$/.exec(column)?.[1] : undefined;
  if (!field || finding.verifiedScopeField !== field) return;
  return field;
}

// The call after which a new `.where()` can be appended for each operation.
function scopeAnchor(chain: DrizzleChain): CallExpression | undefined {
  if (chain.operation === 'select') return chain.steps.find((step) => step.name === 'from')?.call;
  if (chain.operation === 'update') return chain.steps.find((step) => step.name === 'set')?.call;
  if (chain.operation === 'delete') return chain.rootCall;
}

function drizzleScopeTarget(node: Node, finding: Finding): ScopeTarget | undefined {
  const field = verifiedScopeField(finding);
  if (!field) return;
  const chain = drizzleChain(node);
  if (!chain) return;
  const wheres = chain.steps.filter((step) => step.name === 'where');
  const anchor = scopeAnchor(chain);
  const table = chain.operation === 'select' ? anchor?.arguments[0] : chain.rootCall.arguments[0];
  if (!anchor || !table || !isPlainReference(table) || wheres.length > 1) return;
  return { field, anchor, table, where: wheres[0] };
}

function scopeEdit(
  where: ChainStep | undefined,
  anchor: CallExpression,
  condition: string,
  imports: DrizzleImports,
): TextEdit {
  if (!where) return { start: anchor.end, end: anchor.end, text: `.where(${condition})` };
  return {
    start: where.call.arguments[0].getStart(),
    end: where.call.arguments[0].end,
    text: `${imports.local.and}(${condition}, ${textOf(where.call.arguments[0])})`,
  };
}

export function drizzleScopeUnverified({ finding, node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const target = drizzleScopeTarget(node, finding);
  if (!target) return;
  const { field, anchor, table, where } = target;
  if (where && where.call.arguments.length !== 1) return;
  const imports = drizzleImports(sourceFile, where ? ['eq', 'and'] : ['eq']);
  if (!imports) return;
  const condition = `${imports.local.eq}(${textOf(table)}.${field}, ${field})`;
  return {
    edits: [...imports.edits, scopeEdit(where, anchor, condition, imports)],
    note: `Filters by the \`${field}\` declared above. The checker verified its value comes from the configured authorization function.`,
  };
}

// ---- drizzle-unfiltered-write ----

// The rule also counts `void work()` and `and(void work())` as no filter; replacing such an
// argument would drop the call, so only arguments built from names, literals and Drizzle's
// `and`/`or` are replaced.
function isEffectFree(node: Node): boolean {
  if (ts.isCallExpression(node) && !(ts.isIdentifier(node.expression) && ['and', 'or'].includes(node.expression.text)))
    return false;
  if (
    ts.isNewExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isDeleteExpression(node) ||
    ts.isPrefixUnaryExpression(node) ||
    ts.isPostfixUnaryExpression(node) ||
    (ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
  )
    return false;
  return !ts.forEachChild(node, (child) => !isEffectFree(child));
}

export function drizzleUnfilteredWrite({ finding, node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  // Only the same-boolean UPDATE has a filter implied by the code itself; any other filter would be
  // invented.
  if (!finding.message.startsWith('This unfiltered UPDATE rewrites every row with the same boolean')) return;
  const chain = drizzleChain(node);
  if (!chain || chain.operation !== 'update' || chain.steps.some((step) => step.name === 'returning')) return;
  const table = chain.rootCall.arguments[0];
  const set = chain.steps.find((step) => step.name === 'set')?.call;
  const assignments = set?.arguments[0];
  if (!set || !table || !isPlainReference(table) || !assignments || !ts.isObjectLiteralExpression(assignments)) return;
  const [assignment] = assignments.properties;
  if (!ts.isPropertyAssignment(assignment) || !ts.isIdentifier(assignment.name)) return;
  const wheres = chain.steps.filter((step) => step.name === 'where');
  if (wheres.length > 1 || (wheres[0] && wheres[0].call.arguments.length > 1)) return;
  if (wheres[0]?.call.arguments.length && !isEffectFree(wheres[0].call.arguments[0])) return;
  // A NOT NULL column never holds null, so `ne` alone is exact.
  const needsNullCheck = !finding.message.includes('declared NOT NULL');
  const imports = drizzleImports(sourceFile, needsNullCheck ? ['or', 'ne', 'isNull'] : ['ne']);
  if (!imports) return;
  const { or, ne, isNull } = imports.local;
  const column = `${textOf(table)}.${assignment.name.text}`;
  const notEqual = `${ne}(${column}, ${textOf(assignment.initializer)})`;
  const condition = needsNullCheck ? `${or}(${notEqual}, ${isNull}(${column}))` : notEqual;
  const where = wheres[0]?.call;
  const edit: TextEdit = !where
    ? { start: set.end, end: set.end, text: `.where(${condition})` }
    : where.arguments.length
      ? { start: where.arguments[0].getStart(), end: where.arguments[0].end, text: condition }
      : { start: where.end - 1, end: where.end - 1, text: condition };
  return {
    edits: [...imports.edits, edit],
    requiresReview: true,
    note: 'Rows that already hold this value are no longer rewritten, so the affected-row count drops and update triggers or row locks no longer apply to them. Keep the old form if anything depends on those.',
  };
}
