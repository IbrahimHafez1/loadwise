// The element model the accessibility rules read. JSX and markup templates are both translated into it, so each rule is
// written once and applies to React, Vue, Svelte, Angular and plain HTML alike.

/** An attribute value as far as the source shows it. */
export type MarkupAttributeValue =
  /**
   * A literal string, or no value at all (`<input disabled>` gives the empty string). A JSX string or number literal
   * in braces (`tabIndex={1}`, `alt={"Logo"}`) counts as static too.
   */
  | { kind: 'static'; text: string }
  /** A value computed at runtime: a JSX expression, `:alt="x"`, `[alt]="x"`, `alt={x}` or an interpolated string. */
  | { kind: 'dynamic' };

export interface MarkupAttribute {
  /**
   * The HTML attribute name in lower case, so rules compare one spelling. JSX props map to their HTML names
   * (`htmlFor` gives `for`, `className` gives `class`, `tabIndex` gives `tabindex`), and framework bindings are
   * unwrapped: Vue `:alt` / `v-bind:alt`, Angular `[alt]` / `[attr.alt]` and Svelte `alt={x}` all give `alt`. Event
   * bindings become `on<event>` without modifiers: JSX `onClick`, Vue `@click.prevent` / `v-on:click`, Angular
   * `(click)` and Svelte `on:click` all give `onclick`, and Angular `(keydown.enter)` gives `onkeydown`.
   */
  name: string;
  value: MarkupAttributeValue;
  /** 1-based position of the attribute name, for findings and fixes. */
  line: number;
  column: number;
}

export interface MarkupElement {
  /**
   * The tag name. Lower case for intrinsic HTML elements (`img`, `button`); as written for components (`Image`,
   * `Foo.Bar`, `my-widget`), which rules skip unless they know the component.
   */
  tagName: string;
  /** True for lower-case tags without a dot or dash: the elements whose semantics the rules know. */
  isIntrinsic: boolean;
  attributes: readonly MarkupAttribute[];
  /**
   * True when an attribute spread (`{...props}`, `v-bind="obj"`, `{...$$restProps}`) may supply attributes the source
   * does not show; rules that report a missing attribute stay silent then.
   */
  hasSpreadAttributes: boolean;
  /** The direct and nested children, in source order. */
  children: readonly MarkupElement[];
  /** 1-based position of the opening `<`. */
  line: number;
  column: number;
}

/** One file's elements, with the file path findings use. */
export interface MarkupDocument {
  file: string;
  /** The top-level elements; each element carries its children. */
  roots: readonly MarkupElement[];
  /** The full text the positions refer to. */
  text: string;
}

/** Lower-case tag names without a dot or dash: the elements whose semantics the rules know. */
const intrinsicTagPattern = /^[a-z][a-z0-9]*$/;

// Server-side template markers an .html file can carry: Jinja/Liquid/Handlebars/Go `{{ }}`, `{% %}`, `{# #}`, EJS/ERB
// `<% %>` and PHP `<?`. A value holding one is computed before the browser sees it, and a file holding one may be
// assembled from other templates. `{#` is included for both uses: a Jinja comment marks a Jinja file, and staying
// silent on a file that might pull its labels from elsewhere is the cheaper mistake.
const serverTemplateMarker = /\{\{|\{%|\{#|<%|<\?/;

function attributeNamed(element: MarkupElement, name: string): MarkupAttribute | undefined {
  return element.attributes.find((attribute) => attribute.name === name);
}

function staticAttributeText(element: MarkupElement, name: string): string | undefined {
  const attribute = attributeNamed(element, name);
  return attribute?.value.kind === 'static' ? attribute.value.text : undefined;
}

/** Every element of the document, parents before their children. */
function* walkElements(roots: readonly MarkupElement[]): Generator<MarkupElement> {
  for (const element of roots) {
    yield element;
    yield* walkElements(element.children);
  }
}

export { attributeNamed, intrinsicTagPattern, serverTemplateMarker, staticAttributeText, walkElements };
