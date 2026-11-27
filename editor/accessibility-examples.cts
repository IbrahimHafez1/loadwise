// Generic fix examples for the accessibility rules. Markup differs between JSX (`onClick`, `tabIndex`) and HTML, Vue,
// Svelte and Angular templates, so a rule lists both spellings.
import type { FixExample } from './types/fix-example.cjs';

interface MarkupChange {
  before: string;
  code: string;
}

interface AccessibilityExample {
  jsx: MarkupChange;
  html: MarkupChange;
  note: string;
}

const examples: Record<string, AccessibilityExample> = {
  'a11y-img-missing-alt': {
    jsx: { before: '<img src={logo} />', code: '<img src={logo} alt="Company logo" />' },
    html: { before: '<img src="logo.png">', code: '<img src="logo.png" alt="Company logo">' },
    note: 'Describe the image, or use alt="" if it is decorative.',
  },
  'a11y-button-missing-type': {
    jsx: {
      before: '<button onClick={save}>Save</button>',
      code: '<button type="button" onClick={save}>Save</button>',
    },
    html: {
      before: '<button onclick="save()">Save</button>',
      code: '<button type="button" onclick="save()">Save</button>',
    },
    note: 'Use type="submit" if the button should submit its form.',
  },
  'a11y-clickable-non-interactive': {
    jsx: {
      before: '<div onClick={open}>Open</div>',
      code: '<button type="button" onClick={open}>Open</button>',
    },
    html: {
      before: '<div onclick="open()">Open</div>',
      code: '<button type="button" onclick="open()">Open</button>',
    },
    note: 'A button works with the keyboard and screen readers without extra attributes.',
  },
  'a11y-invalid-aria': {
    jsx: { before: '<div aria-lable="Close" />', code: '<div aria-label="Close" />' },
    html: { before: '<div aria-lable="Close"></div>', code: '<div aria-label="Close"></div>' },
    note: 'Assistive technology ignores names that are not WAI-ARIA attributes.',
  },
  'a11y-missing-form-label': {
    jsx: {
      before: '<input type="email" placeholder="Email" />',
      code: '<label>Email <input type="email" /></label>',
    },
    html: {
      before: '<input type="email" placeholder="Email">',
      code: '<label>Email <input type="email"></label>',
    },
    note: 'A placeholder is not a label; wrap the input, or use label for, or aria-label.',
  },
  'a11y-html-missing-lang': {
    jsx: { before: '<html>', code: '<html lang="en">' },
    html: { before: '<html>', code: '<html lang="en">' },
    note: 'Set the language of the page content.',
  },
  'a11y-iframe-missing-title': {
    jsx: { before: '<iframe src={mapUrl} />', code: '<iframe src={mapUrl} title="Store location map" />' },
    html: {
      before: '<iframe src="/map"></iframe>',
      code: '<iframe src="/map" title="Store location map"></iframe>',
    },
    note: 'The title is what screen readers announce for the frame.',
  },
  'a11y-positive-tabindex': {
    jsx: { before: '<div tabIndex={2} />', code: '<div tabIndex={0} />' },
    html: { before: '<div tabindex="2"></div>', code: '<div tabindex="0"></div>' },
    note: 'Use 0 to join the natural order, or -1 for programmatic focus only.',
  },
  'a11y-viewport-zoom-disabled': {
    jsx: {
      before: '<meta name="viewport" content="width=device-width, user-scalable=no" />',
      code: '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    },
    html: {
      before: '<meta name="viewport" content="width=device-width, user-scalable=no">',
      code: '<meta name="viewport" content="width=device-width, initial-scale=1">',
    },
    note: 'Let users pinch-zoom.',
  },
};

const reactLanguages = ['javascriptreact', 'typescriptreact'];
const markupLanguages = ['html', 'vue', 'svelte', 'angular', 'angular-html'];

function exampleFor(ruleId: string, languageId: string): FixExample | undefined {
  if (!Object.hasOwn(examples, ruleId)) return;
  const { jsx, html, note } = examples[ruleId];
  if (reactLanguages.includes(languageId)) {
    return { language: languageId.startsWith('typescript') ? 'typescript' : 'javascript', ...jsx, note };
  }
  if (!markupLanguages.includes(languageId)) return;
  return { language: 'html', ...html, note };
}

export { exampleFor };
