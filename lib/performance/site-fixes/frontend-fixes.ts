// Auto-fix builders for frontend performance rules.
import { requireReview, ts, ancestor, calleeCall, replaceNode, addOptionsArgument, addProperty } from './helpers.js';
import type { CallExpression, ImportSpecifier, Node, SourceFile } from 'typescript';
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
  if (existing) return existing.propertyName || existing.isTypeOnly ? undefined : [];
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

function reactFetchAbortFix({ node, sourceFile, text }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile || text === undefined) return;
  const fetchCall = calleeCall(node);
  if (!fetchCall || fetchCall.arguments.length === 0 || fetchCall.arguments.length > 2) return;
  const effectCall = ts.findAncestor(
    fetchCall,
    (candidate): candidate is CallExpression =>
      ts.isCallExpression(candidate) &&
      ts.isIdentifier(candidate.expression) &&
      candidate.expression.text === 'useEffect',
  );
  const callback = effectCall?.arguments[0];
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || !ts.isBlock(callback.body))
    return;
  if (
    callback.body.statements.some(ts.isReturnStatement) ||
    /\bAbortController\b/.test(callback.body.getText(sourceFile))
  )
    return;
  const edits: TextEdit[] = [];
  const openBrace = callback.body.getStart(sourceFile) + 1;
  edits.push({ start: openBrace, end: openBrace, text: '\n  const controller = new AbortController();' });
  if (fetchCall.arguments.length === 1) {
    edits.push(addOptionsArgument(fetchCall, 'signal: controller.signal', text));
  } else {
    const opts = ts.skipOuterExpressions(fetchCall.arguments[1]);
    if (!ts.isObjectLiteralExpression(opts)) return;
    edits.push(addProperty(opts, 'signal: controller.signal', text));
  }
  const closeBrace = callback.body.end - 1;
  edits.push({ start: closeBrace, end: closeBrace, text: '  return () => controller.abort();\n' });
  return {
    edits,
    note: 'Creates an `AbortController`, passes `controller.signal` to `fetch()`, and aborts on unmount.',
  };
}

function domListenerCleanupFix({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'addEventListener')
    return;
  const [eventArg, handlerArg] = call.arguments;
  if (!eventArg || !handlerArg || !ts.isIdentifier(handlerArg)) return;
  const effectCall = ts.findAncestor(
    call,
    (candidate): candidate is CallExpression =>
      ts.isCallExpression(candidate) &&
      ts.isIdentifier(candidate.expression) &&
      candidate.expression.text === 'useEffect',
  );
  const callback = effectCall?.arguments[0];
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || !ts.isBlock(callback.body))
    return;
  if (callback.body.statements.some(ts.isReturnStatement)) return;
  const receiver = call.expression.expression.getText(sourceFile);
  const closeBrace = callback.body.end - 1;
  return {
    edits: [
      {
        start: closeBrace,
        end: closeBrace,
        text: `  return () => ${receiver}.removeEventListener(${eventArg.getText(sourceFile)}, ${handlerArg.text});\n`,
      },
    ],
    note: 'Adds a cleanup function that calls `removeEventListener` on unmount.',
  };
}

function angularSubscribeCleanupFix({ node, sourceFile, text }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile || text === undefined || !/\btakeUntilDestroyed\b/.test(text)) return;
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'subscribe') return;
  const receiver = call.expression.expression;
  return {
    edits: [replaceNode(receiver, `${receiver.getText(sourceFile)}.pipe(takeUntilDestroyed())`)],
    note: 'Pipes through `takeUntilDestroyed()` so the subscription completes when the component is destroyed.',
  };
}

const SUBPATH_BARREL_PACKAGES = new Set(['lodash', 'lodash-es', 'date-fns']);

function barrelHeavyImportFix({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const decl = ancestor(node, ts.isImportDeclaration);
  if (!decl || !ts.isStringLiteral(decl.moduleSpecifier)) return;
  const pkg = decl.moduleSpecifier.text;
  if (!SUBPATH_BARREL_PACKAGES.has(pkg)) return;
  const named = decl.importClause?.namedBindings;
  if (!named || !ts.isNamedImports(named) || named.elements.length !== 1 || decl.importClause?.name) return;
  const [spec] = named.elements;
  const imported = (spec.propertyName ?? spec.name).text;
  const local = spec.name.text;
  const dateFnsSpecifier = imported === local ? local : `${imported} as ${local}`;
  const replacement =
    pkg === 'date-fns'
      ? `import { ${dateFnsSpecifier} } from '${pkg}/${imported}';`
      : `import ${local} from '${pkg}/${imported}';`;
  return {
    edits: [replaceNode(decl, replacement)],
    note: `Rewrites barrel import from \`${pkg}\` to subpath \`${pkg}/${imported}\`.`,
  };
}

export default {
  'dom-unthrottled-scroll-resize': passiveListenerFix,
  'angular-default-change-detection': requireReview(
    'OnPush skips change detection for @Input() objects mutated in place; confirm inputs are immutable or signal/observable-driven.',
    angularOnPushFix,
  ),
  'react-fetch-in-effect-no-abort': reactFetchAbortFix,
  'dom-listener-without-cleanup': domListenerCleanupFix,
  'angular-subscribe-without-cleanup': requireReview(
    'Confirm `takeUntilDestroyed()` is called inside an injection context (constructor or field initializer).',
    angularSubscribeCleanupFix,
  ),
  'frontend-barrel-heavy-import': barrelHeavyImportFix,
};
