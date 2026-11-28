import type { ImpactLevel } from '../shared/types.js';

// Rules about markup that people using screen readers, keyboards or zoom cannot use. JSX is read from the shared
// TypeScript pass; HTML files and Vue, Svelte and Angular templates are read as markup files beside it.
// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
const knownRules: ReadonlySet<string> = new Set([
  'a11y-button-missing-type',
  'a11y-clickable-non-interactive',
  'a11y-html-missing-lang',
  'a11y-iframe-missing-title',
  'a11y-img-missing-alt',
  'a11y-invalid-aria',
  'a11y-missing-form-label',
  'a11y-positive-tabindex',
  'a11y-viewport-zoom-disabled',
]);

// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
const impactByRule: Readonly<Record<string, ImpactLevel>> = {
  'a11y-button-missing-type': 'medium',
  'a11y-clickable-non-interactive': 'high',
  'a11y-html-missing-lang': 'medium',
  'a11y-iframe-missing-title': 'medium',
  'a11y-img-missing-alt': 'high',
  'a11y-invalid-aria': 'high',
  'a11y-missing-form-label': 'high',
  'a11y-positive-tabindex': 'medium',
  'a11y-viewport-zoom-disabled': 'high',
};

// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
const descriptionByRule: Readonly<Record<string, string>> = {
  'a11y-button-missing-type':
    'A button inside a form has no type, so it submits the form even when it only meant to run a handler.',
  'a11y-clickable-non-interactive':
    'A click handler sits on a non-interactive element without a role and keyboard support, so keyboard users cannot activate it.',
  'a11y-html-missing-lang': 'The html element has no lang attribute, so screen readers guess the pronunciation.',
  'a11y-iframe-missing-title': 'An iframe has no title, so screen readers cannot say what it contains.',
  'a11y-img-missing-alt': 'An image has no alt text, so screen readers announce its file name or nothing.',
  'a11y-invalid-aria': 'An ARIA attribute or role is misspelled or invalid, so assistive technology ignores it.',
  'a11y-missing-form-label': 'A form control has no label, so screen readers announce it without its purpose.',
  'a11y-positive-tabindex': 'A positive tabindex reorders keyboard focus away from the visual order.',
  'a11y-viewport-zoom-disabled':
    'The viewport meta tag disables zoom, so people with low vision cannot enlarge the page.',
};

export { knownRules, impactByRule, descriptionByRule };
