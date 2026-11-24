const maxHtmlEntryBytes = 1024 * 1024;
const rawTextTags = new Set([
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
]);
const inertTags = new Set(['math', 'svg', 'template']);
const scriptTypes = new Set([
  '',
  'module',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
]);
const localSource = /^(?!\/)[\w./-]+\.[cm]?[jt]sx?$/i;

function parseAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const attribute = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/g;
  for (const [, name, doubleQuoted, singleQuoted, bare] of text.matchAll(attribute)) {
    const key = name.toLowerCase();
    if (!attributes.has(key)) attributes.set(key, doubleQuoted ?? singleQuoted ?? bare ?? '');
  }
  return attributes;
}

function htmlScriptEntries(text = ''): string[] {
  const entries: string[] = [];
  const markup = /<(?:\/?[a-z]|[!?])/gi;
  const element =
    /<(\/)?([a-z][a-z0-9:-]*)(?=[\s/>])((?:[^"'<>]|"[^"]*"|'[^']*')*)>|<!--(?:[\s\S]*?--!?>|[\s\S]*$)|<!doctype(?:\s+[^<>]*)?>/iy;
  const inert: string[] = [];
  for (let start = markup.exec(text); start; start = markup.exec(text)) {
    element.lastIndex = start.index;
    const tag = element.exec(text);
    if (!tag) return [];
    markup.lastIndex = element.lastIndex;
    const [, closing, tagName, attributes] = tag;
    if (!tagName) continue;

    const name = tagName.toLowerCase();
    if (closing) {
      if (inert.at(-1) === name) inert.pop();
      continue;
    }
    if (inertTags.has(name)) inert.push(name);
    if (name === 'plaintext') break;
    if (!inert.length && (name === 'base' || name === 'script')) {
      const values = parseAttributes(attributes);
      if (name === 'base' && values.has('href')) return [];
      const src = values.get('src')?.trim();
      const type = values.get('type')?.trim().toLowerCase() ?? '';
      if (name === 'script' && src && scriptTypes.has(type) && localSource.test(src)) entries.push(src);
    }

    // Markup inside raw text such as inline JavaScript or a textarea is not parsed as HTML.
    if (rawTextTags.has(name)) {
      const endTag = new RegExp('</' + name + '\\s*>', 'gi');
      endTag.lastIndex = markup.lastIndex;
      markup.lastIndex = endTag.exec(text) ? endTag.lastIndex : text.length;
    }
  }
  return entries;
}

export { htmlScriptEntries, maxHtmlEntryBytes };
