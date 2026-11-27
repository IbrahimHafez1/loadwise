// Reads HTML files and Vue, Svelte and Angular templates into the element model with a tolerant tokenizer: it never
// throws, ignores end tags that match nothing and closes elements left open at the end of the region.
import { intrinsicTagPattern } from './markup.js';
import type { MarkupAttribute, MarkupDocument, MarkupElement } from './markup.js';
import { normalizeAttribute } from './template-attributes.js';
import type { TemplateDialect } from './template-attributes.js';

export type { TemplateDialect };

const voidElements: ReadonlySet<string> = new Set([
  'img',
  'input',
  'br',
  'meta',
  'link',
  'area',
  'base',
  'col',
  'embed',
  'hr',
  'source',
  'track',
  'wbr',
]);
// Their content is text or code, never markup.
const rawTextElements: ReadonlySet<string> = new Set(['script', 'style', 'textarea', 'title']);
// Rules and the tree walks recurse once per nesting level; deeper tags of a pathological file become siblings so the
// recursion stays shallow.
const maxOpenElements = 500;

const paragraphClosers = [
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'div',
  'dl',
  'fieldset',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
];
const sectionGroup = ['td', 'th', 'tr', 'thead', 'tbody', 'tfoot'];
// Opening the key tag closes an open element named in the value, for the HTML omitted-end-tag cases.
const impliedClosures: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['li', new Set(['li'])],
  ['dt', new Set(['dt', 'dd'])],
  ['dd', new Set(['dt', 'dd'])],
  ['td', new Set(['td', 'th'])],
  ['th', new Set(['td', 'th'])],
  ['tr', new Set(['td', 'th', 'tr'])],
  ['thead', new Set(sectionGroup)],
  ['tbody', new Set(sectionGroup)],
  ['tfoot', new Set(sectionGroup)],
  ['option', new Set(['option'])],
  ['optgroup', new Set(['option', 'optgroup'])],
  ...paragraphClosers.map((tag): [string, ReadonlySet<string>] => [tag, new Set(['p'])]),
]);

// Server-side markers that can sit between attributes inside a tag, with the closer that ends each.
const serverTagMarkers: readonly (readonly [string, string])[] = [
  ['{{', '}}'],
  ['{%', '%}'],
  ['{#', '#}'],
  ['<%', '%>'],
  ['<?', '?>'],
];

interface OpenElement {
  tagName: string;
  matchKey: string;
  isIntrinsic: boolean;
  isTransparent: boolean;
  attributes: MarkupAttribute[];
  hasSpreadAttributes: boolean;
  children: MarkupElement[];
  line: number;
  column: number;
}

interface OpenElementInit {
  tagName: string;
  matchKey: string;
  offset: number;
  attributes: MarkupAttribute[];
  hasSpreadAttributes: boolean;
  isTransparent: boolean;
}

interface ParsedAttributes {
  attributes: MarkupAttribute[];
  hasSpreadAttributes: boolean;
  isSelfClosing: boolean;
  next: number;
}

function lineStartOffsets(text: string): number[] {
  return [0, ...Array.from(text.matchAll(/\n/g), (newline) => newline.index + 1)];
}

function isWhitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\n' || character === '\t' || character === '\r' || character === '\f';
}

class TemplateParser {
  private position: number;
  private readonly lineStarts: number[];
  private readonly stack: OpenElement[];
  private readonly lastIndexByNeedle = new Map<string, number>();

  constructor(
    private readonly text: string,
    private readonly dialect: TemplateDialect,
    start: number,
    private readonly end: number,
  ) {
    this.position = start;
    this.lineStarts = lineStartOffsets(text);
    this.stack = [
      this.openElement({
        tagName: '',
        matchKey: '',
        offset: 0,
        attributes: [],
        hasSpreadAttributes: false,
        isTransparent: false,
      }),
    ];
  }

  parse(): MarkupElement[] {
    while (this.position < this.end) {
      const next = this.readConstruct(this.position);
      this.position = next === -1 ? this.position + 1 : next;
    }
    this.closeDownTo(1);
    return this.stack[0].children;
  }

  private top(): OpenElement {
    return this.stack[this.stack.length - 1];
  }

  private lineAndColumn(offset: number): { line: number; column: number } {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low + 1, column: offset - this.lineStarts[low] + 1 };
  }

  private openElement(init: OpenElementInit): OpenElement {
    const { tagName, matchKey, offset, attributes, hasSpreadAttributes, isTransparent } = init;
    const { line, column } = this.lineAndColumn(offset);
    return {
      tagName,
      matchKey,
      isIntrinsic: intrinsicTagPattern.test(tagName),
      isTransparent,
      attributes,
      hasSpreadAttributes,
      children: [],
      line,
      column,
    };
  }

  /** The end of the construct starting at `at`, or -1 when `at` is plain text. */
  private readConstruct(at: number): number {
    const character = this.text[at];
    if (character === '<') return this.readMarkup(at);
    if (character === '{') return this.readBrace(at);
    return -1;
  }

  private indexWithin(needle: string, from: number): number {
    // Once no `needle` remains past `from`, every later search for it is answered without scanning to the end again.
    let lastIndex = this.lastIndexByNeedle.get(needle);
    if (lastIndex === undefined) {
      lastIndex = this.text.lastIndexOf(needle);
      this.lastIndexByNeedle.set(needle, lastIndex);
    }
    if (from > lastIndex) return -1;
    const index = this.text.indexOf(needle, from);
    return index === -1 || index + needle.length > this.end ? -1 : index;
  }

  /** Consumes `at` up to just past `closer`, or to the region end when it never comes. */
  private skipUntil(closer: string, from: number): number {
    const close = this.indexWithin(closer, from);
    return close === -1 ? this.end : close + closer.length;
  }

  private readMarkup(at: number): number {
    const following = this.text[at + 1];
    const isServerHtml = this.dialect === 'html';
    if (isServerHtml && following === '%' && this.indexWithin('%>', at + 2) !== -1) return this.skipUntil('%>', at + 2);
    if (following === '?') return this.skipUntil(isServerHtml ? '?>' : '>', at + 2);
    if (this.text.startsWith('<!--', at)) return this.skipUntil('-->', at + 4);
    if (this.text.startsWith('<![CDATA[', at)) return this.skipUntil(']]>', at + 9);
    if (following === '!') return this.skipUntil('>', at + 2);
    if (following === '/' && /[A-Za-z]/.test(this.text[at + 2] ?? '')) return this.readEndTag(at);
    if (/[A-Za-z]/.test(following ?? '')) return this.readStartTag(at);
    return -1;
  }

  private readBrace(at: number): number {
    if (this.dialect === 'svelte') return this.closingBrace(at);
    if (this.text[at + 1] === '#' && this.dialect === 'html') return this.skipUntil('#}', at + 2);
    if (this.text[at + 1] === '%' && this.dialect === 'html') {
      return this.indexWithin('%}', at + 2) === -1 ? -1 : this.skipUntil('%}', at + 2);
    }
    if (this.text[at + 1] !== '{' || this.indexWithin('}}', at + 2) === -1) return -1;
    return this.skipUntil('}}', at + 2);
  }

  /** The offset just after the `}` closing the `{` at `open`, skipping nested braces and string literals; -1 if none. */
  private closingBrace(open: number): number {
    if (this.indexWithin('}', open) === -1) return -1;
    let depth = 0;
    let quote = '';
    for (let index = open; index < this.end; index++) {
      const character = this.text[index];
      if (quote) {
        if (character === '\\') index++;
        else if (character === quote) quote = '';
      } else if (character === '"' || character === "'" || character === '`') quote = character;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) return index + 1;
    }
    return -1;
  }

  private readEndTag(at: number): number {
    let nameEnd = at + 2;
    while (nameEnd < this.end && !isWhitespace(this.text[nameEnd]) && !'/>'.includes(this.text[nameEnd])) nameEnd++;
    const rawName = this.text.slice(at + 2, nameEnd);
    const matchKey = this.dialect === 'html' ? rawName.toLowerCase() : rawName;
    const close = this.indexWithin('>', nameEnd);
    for (let index = this.stack.length - 1; index > 0; index--) {
      if (this.stack[index].matchKey !== matchKey) continue;
      this.closeDownTo(index);
      break;
    }
    return close === -1 ? this.end : close + 1;
  }

  private closeDownTo(depth: number): void {
    while (this.stack.length > depth) this.closeTop();
  }

  private closeTop(): void {
    const frame = this.stack.pop();
    if (!frame || frame.isTransparent) return;
    this.top().children.push({
      tagName: frame.tagName,
      isIntrinsic: frame.isIntrinsic,
      attributes: frame.attributes,
      hasSpreadAttributes: frame.hasSpreadAttributes,
      children: frame.children,
      line: frame.line,
      column: frame.column,
    });
  }

  private isTransparentTag(tagName: string): boolean {
    if (tagName === 'template') return this.dialect === 'vue' || this.dialect === 'angular';
    return tagName === 'ng-template' || tagName === 'ng-container' || tagName === 'svelte:fragment';
  }

  private readStartTag(at: number): number {
    let nameEnd = at + 1;
    while (nameEnd < this.end && !isWhitespace(this.text[nameEnd]) && !'/>'.includes(this.text[nameEnd])) nameEnd++;
    const rawName = this.text.slice(at + 1, nameEnd);
    const tagName = this.dialect === 'html' ? rawName.toLowerCase() : rawName;
    const parsed = this.parseAttributes(nameEnd);
    if (this.dialect === 'html') this.applyImpliedClosures(tagName);
    const frame = this.openElement({
      tagName,
      matchKey: tagName,
      offset: at,
      attributes: parsed.attributes,
      hasSpreadAttributes: parsed.hasSpreadAttributes,
      isTransparent: this.isTransparentTag(tagName),
    });
    const isIntrinsicLower = intrinsicTagPattern.test(tagName);
    const isTooDeep = this.stack.length > maxOpenElements;
    if (parsed.isSelfClosing || isTooDeep || (isIntrinsicLower && voidElements.has(tagName))) {
      this.stack.push(frame);
      this.closeTop();
      return parsed.next;
    }
    if (isIntrinsicLower && rawTextElements.has(tagName)) return this.readRawText(frame, parsed.next);
    if (frame.isTransparent) frame.children = this.top().children;
    this.stack.push(frame);
    return parsed.next;
  }

  private applyImpliedClosures(tagName: string): void {
    const closable = impliedClosures.get(tagName);
    if (!closable) return;
    while (this.stack.length > 1 && closable.has(this.top().matchKey)) this.closeTop();
  }

  /** Reads the body of script/style/textarea/title up to its end tag without looking for markup in it. */
  private readRawText(frame: OpenElement, bodyStart: number): number {
    const endTag = new RegExp(`</${frame.tagName}(?=[\\s/>])`, 'gi');
    endTag.lastIndex = bodyStart;
    const match = endTag.exec(this.text);
    const bodyEnd = match && match.index < this.end ? match.index : this.end;
    this.stack.push(frame);
    this.closeTop();
    const close = this.indexWithin('>', bodyEnd);
    return close === -1 ? this.end : close + 1;
  }

  private parseAttributes(from: number): ParsedAttributes {
    const parsed: ParsedAttributes = {
      attributes: [],
      hasSpreadAttributes: false,
      isSelfClosing: false,
      next: this.end,
    };
    let index = from;
    while (index < this.end) {
      const character = this.text[index];
      if (isWhitespace(character)) index++;
      else if (character === '>') return { ...parsed, next: index + 1 };
      else if (character === '/' && this.text[index + 1] === '>')
        return { ...parsed, isSelfClosing: true, next: index + 2 };
      else if (character === '/') index++;
      else index = this.readAttribute(index, parsed);
    }
    return parsed;
  }

  /** Reads one attribute (or template statement inside the tag) at `index` into `parsed`; returns the next offset. */
  private readAttribute(index: number, parsed: ParsedAttributes): number {
    const serverEnd = this.skipServerMarkerInTag(index);
    if (serverEnd !== -1) {
      parsed.hasSpreadAttributes = true;
      return serverEnd;
    }
    if (this.dialect === 'svelte' && this.text[index] === '{') return this.readSvelteTagBrace(index, parsed);
    let nameEnd = index;
    while (nameEnd < this.end && !this.endsAttributeName(nameEnd)) nameEnd++;
    if (nameEnd === index) return index + 1;
    const rawName = this.text.slice(index, nameEnd);
    const { value, isBraced, next } = this.readAttributeValue(nameEnd);
    this.record(parsed, index, normalizeAttribute(this.dialect, rawName, value, isBraced));
    return next;
  }

  private endsAttributeName(index: number): boolean {
    const character = this.text[index];
    if (isWhitespace(character) || character === '=' || character === '>') return true;
    return character === '/' && this.text[index + 1] === '>';
  }

  private skipServerMarkerInTag(index: number): number {
    if (this.dialect !== 'html') return -1;
    for (const [opener, closer] of serverTagMarkers) {
      if (!this.text.startsWith(opener, index)) continue;
      const close = this.indexWithin(closer, index + opener.length);
      return close === -1 ? this.end : close + closer.length;
    }
    return -1;
  }

  private readSvelteTagBrace(index: number, parsed: ParsedAttributes): number {
    const close = this.closingBrace(index);
    if (close === -1) return this.end;
    const inner = this.text.slice(index + 1, close - 1).trim();
    if (inner.startsWith('...')) parsed.hasSpreadAttributes = true;
    else if (/^[\w$]+$/.test(inner))
      this.record(parsed, index, { kind: 'attribute', name: inner.toLowerCase(), value: { kind: 'dynamic' } });
    return close;
  }

  private readAttributeValue(afterName: number): { value: string | undefined; isBraced: boolean; next: number } {
    let index = afterName;
    while (isWhitespace(this.text[index])) index++;
    if (this.text[index] !== '=') return { value: undefined, isBraced: false, next: afterName };
    index++;
    while (isWhitespace(this.text[index])) index++;
    const opener = this.text[index];
    if (opener === '"' || opener === "'") {
      const close = this.indexWithin(opener, index + 1);
      const valueEnd = close === -1 ? this.end : close;
      return { value: this.text.slice(index + 1, valueEnd), isBraced: false, next: Math.min(valueEnd + 1, this.end) };
    }
    if (opener === '{' && this.dialect === 'svelte') {
      const close = this.closingBrace(index);
      const valueEnd = close === -1 ? this.end : close;
      return { value: this.text.slice(index + 1, valueEnd), isBraced: true, next: valueEnd };
    }
    let valueEnd = index;
    while (valueEnd < this.end && !isWhitespace(this.text[valueEnd]) && this.text[valueEnd] !== '>') valueEnd++;
    // `<Foo bar=baz/>`: the slash closes the tag rather than belonging to the value.
    const closesTag = this.text[valueEnd] === '>' && this.text[valueEnd - 1] === '/' && valueEnd - 1 > index;
    return {
      value: this.text.slice(index, closesTag ? valueEnd - 1 : valueEnd),
      isBraced: false,
      next: closesTag ? valueEnd - 1 : valueEnd,
    };
  }

  private record(
    parsed: ParsedAttributes,
    nameOffset: number,
    normalized: ReturnType<typeof normalizeAttribute>,
  ): void {
    if (normalized.kind === 'spread') parsed.hasSpreadAttributes = true;
    else if (normalized.kind === 'attribute') {
      const { line, column } = this.lineAndColumn(nameOffset);
      parsed.attributes.push({ name: normalized.name, value: normalized.value, line, column });
    }
  }
}

/**
 * Parses the region `[start, end)` of `text` as markup of the given dialect. `text` is always the full text of the file
 * (the document keeps it and every position refers to it), so a Vue `<template>` block or an inline Angular template
 * is addressed by its region rather than sliced out.
 */
function templateDocument(
  file: string,
  text: string,
  dialect: TemplateDialect,
  start = 0,
  end = text.length,
): MarkupDocument {
  const roots = new TemplateParser(text, dialect, start, Math.min(end, text.length)).parse();
  return { file, roots, text };
}

export { templateDocument };
