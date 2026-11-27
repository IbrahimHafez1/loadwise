// Turns the attribute spellings of HTML, Vue, Svelte and Angular templates into the one name and value shape the
// rules read (see markup.ts).
import { validAttributeNames } from './aria-tables.js';
import { serverTemplateMarker } from './markup.js';
import type { MarkupAttributeValue } from './markup.js';

export type TemplateDialect = 'html' | 'vue' | 'svelte' | 'angular';

/** What one written attribute means to the rules. */
export type NormalizedAttribute =
  | { kind: 'attribute'; name: string; value: MarkupAttributeValue }
  /** The attribute may supply attributes the source does not show (`v-bind="obj"`, `{...props}`). */
  | { kind: 'spread' }
  /** Directives such as `v-if` or `*ngIf` that are not HTML attributes at all. */
  | { kind: 'ignored' };

const spread: NormalizedAttribute = { kind: 'spread' };
const ignored: NormalizedAttribute = { kind: 'ignored' };

const eventIgnoredPrefixes = ['class:', 'style:', 'use:', 'transition:', 'in:', 'out:', 'animate:', 'let:'];
// Properties that fill the element at runtime; they are not attributes the rules read.
const angularContentProperties = new Set(['innerhtml', 'textcontent', 'innertext']);

function hasInterpolation(dialect: TemplateDialect, value: string): boolean {
  if (dialect === 'html') return serverTemplateMarker.test(value);
  if (dialect === 'svelte') return value.includes('{');
  return value.includes('{{');
}

// `@click.stop`, `(click)="$event.stopPropagation()"` or `on:click={(e) => e.stopPropagation()}` keeps a click inside
// a panel from reaching a backdrop; it is not a way to activate the element, so it is left out like a missing handler.
const propagationOnlyHandler =
  /^\s*(?:\(?[\w$]*\)?\s*=>\s*)?\{?\s*(?:[\w$]+\.(?:stopPropagation|preventDefault)\(\)(?:\s*;)?\s*)+\}?\s*$/;
// `@click="() => {}"` does nothing, so it is no more a way to activate the element than a propagation-only handler. A
// Svelte `on:click={…}` value keeps its closing brace, hence the optional second one.
const emptyHandler = /^\s*(?:\(?[\w$]*\)?\s*=>\s*)?\{\s*\}\}?\s*$/;

function eventAttribute(event: string, rawValue: string | undefined, isBareAllowed: boolean): NormalizedAttribute {
  const isBare = rawValue === undefined || rawValue.trim() === '';
  if (isBare && isBareAllowed) return ignored;
  if (rawValue !== undefined && (propagationOnlyHandler.test(rawValue) || emptyHandler.test(rawValue))) return ignored;
  return dynamicAttribute(`on${event}`);
}

function dynamicAttribute(name: string): NormalizedAttribute {
  return { kind: 'attribute', name, value: { kind: 'dynamic' } };
}

function withoutModifiers(argument: string): string {
  return argument.split('.')[0] ?? argument;
}

function plainAttribute(
  dialect: TemplateDialect,
  name: string,
  rawValue: string | undefined,
  isBraced: boolean,
): NormalizedAttribute {
  if (isBraced || (rawValue !== undefined && hasInterpolation(dialect, rawValue))) return dynamicAttribute(name);
  return { kind: 'attribute', name, value: { kind: 'static', text: rawValue ?? '' } };
}

function vueAttribute(
  name: string,
  rawValue: string | undefined,
  plain: () => NormalizedAttribute,
): NormalizedAttribute {
  if (name === 'v-bind' || name === 'v-on') return spread;
  const boundName = name.startsWith(':') ? name.slice(1) : name.startsWith('v-bind:') ? name.slice(7) : undefined;
  if (boundName !== undefined) {
    const argument = withoutModifiers(boundName);
    return argument.startsWith('[') ? spread : dynamicAttribute(argument);
  }
  const eventName = name.startsWith('@') ? name.slice(1) : name.startsWith('v-on:') ? name.slice(5) : undefined;
  if (eventName !== undefined) {
    const event = withoutModifiers(eventName);
    // A modifier-only `@click.stop` registers no handler of its own.
    return event.startsWith('[') ? ignored : eventAttribute(event, rawValue, true);
  }
  if (name === 'v-model' || name.startsWith('v-model.')) return dynamicAttribute('value');
  if (name.startsWith('v-model:')) return dynamicAttribute(withoutModifiers(name.slice(8)));
  if (name.startsWith('v-') || name.startsWith('#')) return ignored;
  return plain();
}

// `[ariaLabel]` and `[htmlFor]` are DOM property names; rules compare attribute names. An `aria…` input that is no
// ARIA property (RouterLink's `[ariaCurrentWhenActive]`) keeps its property name, so it never reaches the aria- check.
function propertyToAttributeName(property: string): string {
  if (property === 'htmlfor') return 'for';
  if (property === 'classname') return 'class';
  if (!property.startsWith('aria') || property.includes('-')) return property;
  const attributeName = `aria-${property.slice(4)}`;
  return validAttributeNames.has(attributeName) ? attributeName : property;
}

function angularAttribute(
  name: string,
  rawValue: string | undefined,
  plain: () => NormalizedAttribute,
): NormalizedAttribute {
  if (name.startsWith('[(')) return ignored;
  if (name.startsWith('[') && name.endsWith(']')) {
    const inner = name.slice(1, -1);
    if (inner.startsWith('attr.')) return dynamicAttribute(inner.slice(5));
    if (inner.startsWith('class.') || inner.startsWith('style.') || inner.startsWith('@')) return ignored;
    if (angularContentProperties.has(inner)) return ignored;
    return dynamicAttribute(propertyToAttributeName(inner));
  }
  if (name.startsWith('(') && name.endsWith(')')) {
    const event = withoutModifiers(name.slice(1, -1));
    return event.startsWith('@') ? ignored : eventAttribute(event, rawValue, true);
  }
  if (name.startsWith('*') || name.startsWith('#') || name.startsWith('@')) return ignored;
  return plain();
}

function svelteAttribute(
  name: string,
  rawValue: string | undefined,
  plain: () => NormalizedAttribute,
): NormalizedAttribute {
  // A bare `on:click` forwards the event to the component's parent, which makes the element clickable all the same.
  if (name.startsWith('on:')) return eventAttribute(name.slice(3).split('|')[0], rawValue, false);
  if (name.startsWith('bind:')) {
    const bound = name.slice(5);
    return bound === 'this' ? ignored : dynamicAttribute(bound);
  }
  if (eventIgnoredPrefixes.some((prefix) => name.startsWith(prefix))) return ignored;
  return plain();
}

// A plain .html file can still hold Angular, Vue or Alpine bindings (`[alt]`, `:alt`, `x-bind:alt`); reading them
// with the framework rules avoids reporting an attribute that is only spelled differently.
function htmlAttribute(
  name: string,
  rawValue: string | undefined,
  plain: () => NormalizedAttribute,
): NormalizedAttribute {
  if (name.startsWith('[') || name.startsWith('(') || name.startsWith('*'))
    return angularAttribute(name, rawValue, plain);
  if (name.startsWith(':') || name.startsWith('@') || name.startsWith('v-')) return vueAttribute(name, rawValue, plain);
  if (name.startsWith('x-')) return vueAttribute(`v-${name.slice(2)}`, rawValue, plain);
  return plain();
}

/**
 * `rawValue` is the text between the quotes (undefined when the attribute has no value); `isBraced` marks a Svelte
 * `name={expr}` value.
 */
function normalizeAttribute(
  dialect: TemplateDialect,
  rawName: string,
  rawValue: string | undefined,
  isBraced: boolean,
): NormalizedAttribute {
  const name = rawName.toLowerCase();
  const plain = () => plainAttribute(dialect, name, rawValue, isBraced);
  if (dialect === 'vue') return vueAttribute(name, rawValue, plain);
  if (dialect === 'angular') return angularAttribute(name, rawValue, plain);
  if (dialect === 'svelte') return svelteAttribute(name, rawValue, plain);
  return htmlAttribute(name, rawValue, plain);
}

export { normalizeAttribute };
