// Auto-fix builders for frontend performance rules.
import { requireReview, ts, ancestor, calleeCall } from './helpers.js';
import type { ImportSpecifier, Node, SourceFile } from 'typescript';
import type { FixResult, SiteFixInput, TextEdit } from '../../shared/types.js';

const PASSIVE_CAPABLE_EVENTS = new Set(['wheel', 'touchmove', 'touchstart']);

// True when the handler can call preventDefault(), which a passive listener would silently ignore.
function mayPreventDefault(handler: Node): boolean {
  let found = false;
  (function visit(node: Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      found ||= node.expression.name.text === 'preventDefault';
    }
    ts.forEachChild(node, visit);
  })(handler);
  return found;
}

// Adds `{ passive: true }` to `addEventListener('wheel' | 'touchmove' | 'touchstart',
// inlineHandler)` when the handler visibly never calls preventDefault(); any other handler could
// depend on cancelling the event, so no edit is offered.
function passiveListenerFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const call = calleeCall(node);
  if (!call || call.arguments.length !== 2) return;
  const [eventArg, handler] = call.arguments;
  if (!ts.isStringLiteralLike(eventArg) || !PASSIVE_CAPABLE_EVENTS.has(eventArg.text)) return;
  if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) return;
  if (mayPreventDefault(handler)) return;
  return {
    edits: [{ start: handler.end, end: handler.end, text: ', { passive: true }' }],
    note: 'Added `{ passive: true }` so the browser does not block scrolling waiting for preventDefault().',
  };
}

const CHANGE_DETECTION_ENUM = 'ChangeDetectionStrategy';

// A type-only binding cannot be used as a value, and importing the name again would be a duplicate
// declaration.
function bindsEnumTypeOnly(sourceFile: SourceFile): boolean {
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      statement.importClause?.isTypeOnly &&
      statement.importClause.getText(sourceFile).includes(CHANGE_DETECTION_ENUM),
  );
}

// The edits that make `ChangeDetectionStrategy` available: none when a `@angular/core` import
// already has it, undefined when no named import from `@angular/core` can take it (so the caller
// offers no fix).
function changeDetectionImportEdits(sourceFile: SourceFile): TextEdit[] | undefined {
  const named = sourceFile.statements.flatMap((statement): ImportSpecifier[] => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) return [];
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    const fromAngularCore = statement.moduleSpecifier.text === '@angular/core' && clause && !clause.isTypeOnly;
    return fromAngularCore && bindings && ts.isNamedImports(bindings) ? [...bindings.elements] : [];
  });
  if (bindsEnumTypeOnly(sourceFile)) return;
  const existing = named.find((element) => (element.propertyName ?? element.name).text === CHANGE_DETECTION_ENUM);
  if (existing) return existing.propertyName ? undefined : [];
  const last = named.at(-1);
  return last ? [{ start: last.end, end: last.end, text: `, ${CHANGE_DETECTION_ENUM}` }] : undefined;
}

// Inserts `changeDetection: ChangeDetectionStrategy.OnPush` into the `@Component({ ... })` metadata
// object and imports the enum from `@angular/core`.
function angularOnPushFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const decorator = ancestor(node, ts.isDecorator);
  if (!decorator || !ts.isCallExpression(decorator.expression)) return;
  const metadata = decorator.expression.arguments[0];
  if (!metadata || !ts.isObjectLiteralExpression(metadata)) return;
  const importEdits = changeDetectionImportEdits(metadata.getSourceFile());
  if (!importEdits) return;
  const insertAt = metadata.getStart(metadata.getSourceFile()) + 1;
  const property = ` changeDetection: ${CHANGE_DETECTION_ENUM}.OnPush${metadata.properties.length > 0 ? ',' : ' '}`;
  return {
    edits: [...importEdits, { start: insertAt, end: insertAt, text: property }],
    note: 'Enabled `ChangeDetectionStrategy.OnPush`.',
  };
}

export default {
  'dom-unthrottled-scroll-resize': passiveListenerFix,
  'angular-default-change-detection': requireReview(
    'OnPush skips change detection for @Input() objects mutated in place; confirm inputs are immutable or signal/observable-driven.',
    angularOnPushFix,
  ),
};
