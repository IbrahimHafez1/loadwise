// The accessibility rules over the shared element model; see markup.ts. Every rule favours silence: a spread, a dynamic
// value or a component may supply what the source does not show.
import type { Finding } from '../shared/types.js';
import { closestAttributeName, closestRoleName, validAttributeNames, validRoleNames } from './aria-tables.js';
import { attributeNamed, serverTemplateMarker, staticAttributeText, walkElements } from './markup.js';
import type { MarkupAttribute, MarkupDocument, MarkupElement } from './markup.js';

interface RuleContext {
  document: MarkupDocument;
  /** The enclosing elements, outermost first. */
  ancestors: readonly MarkupElement[];
  /** Static ids that a label's `for` points at. */
  labelledIds: ReadonlySet<string>;
  /** A label with a computed `for` may point at any control. */
  hasDynamicLabelFor: boolean;
  /** A server template can pull its labels from an include, a parent layout or a partial the file does not show. */
  includesOtherTemplates: boolean;
}

type ElementRule = (element: MarkupElement, context: RuleContext) => Finding[];

// Elements with no built-in keyboard behaviour; a click handler on one needs a role and a key handler.
const nonInteractiveTags: ReadonlySet<string> = new Set([
  'div',
  'span',
  'p',
  'li',
  'ul',
  'ol',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'nav',
  'aside',
  'td',
  'tr',
  'img',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);
const keyHandlerNames = ['onkeydown', 'onkeyup', 'onkeypress'];
const unlabelledInputTypes: ReadonlySet<string> = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
const labelledControlTags: ReadonlySet<string> = new Set(['input', 'select', 'textarea']);
const minimumZoomLimit = 2;
const plainHtmlFile = /\.html?$/i;

function finding(
  document: MarkupDocument,
  at: { line: number; column: number },
  ruleId: string,
  message: string,
): Finding {
  return { file: document.file, line: at.line, column: at.column, ruleId, message };
}

function hasAttribute(element: MarkupElement, name: string): boolean {
  return attributeNamed(element, name) !== undefined;
}

function isStaticValue(element: MarkupElement, name: string, expected: string): boolean {
  return staticAttributeText(element, name)?.trim().toLowerCase() === expected;
}

// aria-hidden, even a computed one, takes the element out of what assistive technology reads.
function isHiddenFromAssistiveTechnology(element: MarkupElement): boolean {
  const hidden = attributeNamed(element, 'aria-hidden');
  return hidden !== undefined && (hidden.value.kind === 'dynamic' || hidden.value.text.trim().toLowerCase() === 'true');
}

function hasAccessibleNameAttribute(element: MarkupElement): boolean {
  return hasAttribute(element, 'aria-label') || hasAttribute(element, 'aria-labelledby');
}

function isPresentationalRole(element: MarkupElement): boolean {
  const role = attributeNamed(element, 'role');
  if (!role) return false;
  if (role.value.kind === 'dynamic') return true;
  return ['presentation', 'none'].includes(role.value.text.trim().toLowerCase());
}

function isImageWithoutAlt(element: MarkupElement): boolean {
  if (element.tagName === 'input') return isStaticValue(element, 'type', 'image') && !hasAttribute(element, 'alt');
  return (element.tagName === 'img' || element.tagName === 'area') && !hasAttribute(element, 'alt');
}

const imgMissingAlt: ElementRule = (element, { document }) => {
  if (!element.isIntrinsic || element.hasSpreadAttributes || !isImageWithoutAlt(element)) return [];
  if (
    hasAccessibleNameAttribute(element) ||
    isPresentationalRole(element) ||
    isHiddenFromAssistiveTechnology(element)
  ) {
    return [];
  }
  const kind = element.tagName === 'input' ? '<input type="image">' : `<${element.tagName}>`;
  return [
    finding(
      document,
      element,
      'a11y-img-missing-alt',
      `${kind} has no alt attribute, so screen readers announce its file name or nothing. Add alt text that says what it shows, or alt="" when it is purely decorative.`,
    ),
  ];
};

// Only a button with its own click handler that the source shows inside a form (or tied to one by its form attribute)
// is reported: outside a form the default submit type does nothing, and a typeless button without a handler is usually
// the form's submit button on purpose.
const buttonMissingType: ElementRule = (element, { document, ancestors }) => {
  if (element.tagName !== 'button' || !element.isIntrinsic || element.hasSpreadAttributes) return [];
  if (hasAttribute(element, 'type') || !hasAttribute(element, 'onclick')) return [];
  // A computed `disabled` may be false, so only a written one means the button cannot be clicked.
  if (staticAttributeText(element, 'disabled') !== undefined) return [];
  const isInForm = hasAttribute(element, 'form') || ancestors.some((ancestor) => ancestor.tagName === 'form');
  if (!isInForm) return [];
  return [
    finding(
      document,
      element,
      'a11y-button-missing-type',
      'This <button> has a click handler but no type, so a click also submits its form. Add type="button" when the handler is all it should do, or type="submit" when it should submit.',
    ),
  ];
};

const clickableNonInteractive: ElementRule = (element, { document }) => {
  if (!element.isIntrinsic || !nonInteractiveTags.has(element.tagName) || element.hasSpreadAttributes) return [];
  if (!hasAttribute(element, 'onclick') || hasAttribute(element, 'role')) return [];
  if (keyHandlerNames.some((name) => hasAttribute(element, name)) || isHiddenFromAssistiveTechnology(element))
    return [];
  return [
    finding(
      document,
      element,
      'a11y-clickable-non-interactive',
      `A click handler on <${element.tagName}> cannot be reached or activated with a keyboard or announced by a screen reader. Use a <button>, or add a role, tabIndex and a key handler.`,
    ),
  ];
};

function invalidAttributeFinding(document: MarkupDocument, attribute: MarkupAttribute): Finding {
  const suggestion = closestAttributeName(attribute.name);
  const hint = suggestion ? ` Did you mean "${suggestion}"?` : '';
  return finding(
    document,
    attribute,
    'a11y-invalid-aria',
    `"${attribute.name}" is not a WAI-ARIA attribute, so assistive technology ignores it.${hint}`,
  );
}

function invalidRoleFinding(document: MarkupDocument, attribute: MarkupAttribute, role: string): Finding {
  const suggestion = closestRoleName(role.toLowerCase());
  const hint = suggestion ? ` Did you mean "${suggestion}"?` : '';
  return finding(
    document,
    attribute,
    'a11y-invalid-aria',
    `"${role}" is not a WAI-ARIA role, so assistive technology ignores it.${hint}`,
  );
}

// A role attribute is a fallback list, so it only fails when no token in it is a real role.
function invalidRoleToken(attribute: MarkupAttribute): string | undefined {
  if (attribute.value.kind !== 'static') return;
  const tokens = attribute.value.text.split(/\s+/).filter(Boolean);
  if (tokens.some((token) => validRoleNames.has(token.toLowerCase()))) return;
  return tokens[0];
}

const invalidAria: ElementRule = (element, { document }) => {
  if (!element.isIntrinsic) return [];
  const findings: Finding[] = [];
  for (const attribute of element.attributes) {
    if (attribute.name.startsWith('aria-') && !validAttributeNames.has(attribute.name)) {
      findings.push(invalidAttributeFinding(document, attribute));
    }
    if (attribute.name !== 'role') continue;
    const invalidRole = invalidRoleToken(attribute);
    if (invalidRole !== undefined) findings.push(invalidRoleFinding(document, attribute, invalidRole));
  }
  return findings;
};

function needsFormLabel(element: MarkupElement): boolean {
  if (!element.isIntrinsic || !labelledControlTags.has(element.tagName)) return false;
  if (element.tagName !== 'input') return true;
  const type = attributeNamed(element, 'type');
  if (!type) return true;
  // A computed type could be hidden or a button, so it stays unreported.
  return type.value.kind === 'static' && !unlabelledInputTypes.has(type.value.text.trim().toLowerCase());
}

// A control with an id in a document that labels nothing by id is usually labelled by a parent component or another
// file; only when the document does label controls by id is a control it skips reported.
function hasLabelFromContext(element: MarkupElement, { ancestors, labelledIds }: RuleContext): boolean {
  // A control in a `<slot>`'s fallback content is labelled by whichever parent fills or wraps the slot.
  if (
    ancestors.some((ancestor) => !ancestor.isIntrinsic || ancestor.tagName === 'label' || ancestor.tagName === 'slot')
  )
    return true;
  const id = attributeNamed(element, 'id');
  if (!id) return false;
  return id.value.kind === 'dynamic' || labelledIds.size === 0 || labelledIds.has(id.value.text);
}

const missingFormLabel: ElementRule = (element, context) => {
  if (!needsFormLabel(element) || element.hasSpreadAttributes || context.hasDynamicLabelFor) return [];
  // A control the user and assistive technology never reach needs no label: a honeypot, a file input behind a button.
  if (hasAttribute(element, 'hidden') || isHiddenFromAssistiveTechnology(element) || isPresentationalRole(element))
    return [];
  if (context.includesOtherTemplates) return [];
  if (hasAccessibleNameAttribute(element) || hasAttribute(element, 'title')) return [];
  if (hasLabelFromContext(element, context)) return [];
  return [
    finding(
      context.document,
      element,
      'a11y-missing-form-label',
      `<${element.tagName}> has no label, so screen readers announce it without saying what to enter. Wrap it in a <label>, point a <label for> at its id, or add aria-label.`,
    ),
  ];
};

const htmlMissingLang: ElementRule = (element, { document }) => {
  if (element.tagName !== 'html' || !element.isIntrinsic || element.hasSpreadAttributes) return [];
  if (staticAttributeText(element, 'lang')?.trim() === '' || !hasAttribute(element, 'lang')) {
    return [
      finding(
        document,
        element,
        'a11y-html-missing-lang',
        'The <html> element has no lang, so screen readers guess the language and may read the page with the wrong pronunciation. Add lang with the page language, such as lang="en".',
      ),
    ];
  }
  return [];
};

const iframeMissingTitle: ElementRule = (element, { document }) => {
  if (element.tagName !== 'iframe' || !element.isIntrinsic || element.hasSpreadAttributes) return [];
  if (
    hasAttribute(element, 'title') ||
    hasAccessibleNameAttribute(element) ||
    isHiddenFromAssistiveTechnology(element)
  ) {
    return [];
  }
  return [
    finding(
      document,
      element,
      'a11y-iframe-missing-title',
      'This <iframe> has no title, so screen readers cannot tell users what it contains. Add a title that describes the embedded content.',
    ),
  ];
};

const positiveTabindex: ElementRule = (element, { document }) => {
  const tabindex = attributeNamed(element, 'tabindex');
  if (!element.isIntrinsic || tabindex?.value.kind !== 'static') return [];
  const text = tabindex.value.text.trim();
  if (!/^\+?\d+$/.test(text) || Number.parseInt(text, 10) <= 0) return [];
  return [
    finding(
      document,
      tabindex,
      'a11y-positive-tabindex',
      `tabindex="${text}" moves this element ahead of the natural keyboard order, so Tab jumps around the page. Use tabIndex 0 or -1 and order the elements in the markup instead.`,
    ),
  ];
};

function viewportDirectives(content: string): Map<string, string> {
  const directives = new Map<string, string>();
  for (const part of content.split(/[,;]/)) {
    const [key, ...rest] = part.split('=');
    if (rest.length) directives.set(key.trim().toLowerCase(), rest.join('=').trim().toLowerCase());
  }
  return directives;
}

function zoomRestriction(directives: ReadonlyMap<string, string>): string | undefined {
  const userScalable = directives.get('user-scalable');
  if (userScalable === 'no' || userScalable === '0') return `user-scalable=${userScalable}`;
  const maximumScaleText = directives.get('maximum-scale');
  const maximumScale = maximumScaleText === undefined ? Number.NaN : Number.parseFloat(maximumScaleText);
  if (maximumScale < minimumZoomLimit) return `maximum-scale=${maximumScaleText}`;
  return undefined;
}

const viewportZoomDisabled: ElementRule = (element, { document }) => {
  if (element.tagName !== 'meta' || !element.isIntrinsic || !isStaticValue(element, 'name', 'viewport')) return [];
  const content = staticAttributeText(element, 'content');
  const restriction = content === undefined ? undefined : zoomRestriction(viewportDirectives(content));
  if (!restriction) return [];
  return [
    finding(
      document,
      element,
      'a11y-viewport-zoom-disabled',
      `The viewport meta tag sets ${restriction}, so people with low vision cannot pinch-zoom the page. Remove it, or allow a maximum-scale of at least 2.`,
    ),
  ];
};

const elementRules: readonly ElementRule[] = [
  imgMissingAlt,
  buttonMissingType,
  clickableNonInteractive,
  invalidAria,
  missingFormLabel,
  htmlMissingLang,
  iframeMissingTitle,
  positiveTabindex,
  viewportZoomDisabled,
];

function isLabelLike(element: MarkupElement): boolean {
  return element.tagName === 'label' || !element.isIntrinsic;
}

// Labels of components count too: a `<Label htmlFor="x">` names the control with that id just as a `<label>` does.
function labelTargets(document: MarkupDocument): { labelledIds: Set<string>; hasDynamicLabelFor: boolean } {
  const labelledIds = new Set<string>();
  let hasDynamicLabelFor = false;
  for (const element of walkElements(document.roots)) {
    const target = isLabelLike(element) ? attributeNamed(element, 'for') : undefined;
    if (target?.value.kind === 'static') labelledIds.add(target.value.text);
    else if (target) hasDynamicLabelFor = true;
  }
  return { labelledIds, hasDynamicLabelFor };
}

// `context.ancestors` is this same stack, so one array serves every element instead of a copy per element.
function checkElement(element: MarkupElement, context: RuleContext, stack: MarkupElement[], findings: Finding[]): void {
  for (const rule of elementRules) findings.push(...rule(element, context));
  stack.push(element);
  for (const child of element.children) checkElement(child, context, stack, findings);
  stack.pop();
}

function includesOtherTemplates(document: MarkupDocument): boolean {
  return plainHtmlFile.test(document.file) && serverTemplateMarker.test(document.text);
}

function checkMarkup(document: MarkupDocument): Finding[] {
  const stack: MarkupElement[] = [];
  const context: RuleContext = {
    document,
    ancestors: stack,
    ...labelTargets(document),
    includesOtherTemplates: includesOtherTemplates(document),
  };
  const findings: Finding[] = [];
  for (const root of document.roots) checkElement(root, context, stack, findings);
  return findings;
}

export { checkMarkup };
