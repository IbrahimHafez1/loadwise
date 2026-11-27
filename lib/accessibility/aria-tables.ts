// The WAI-ARIA names the invalid-aria rule accepts: ARIA 1.2 plus the 1.3 additions browsers already support.

const ariaAttributeNames: readonly string[] = [
  'aria-activedescendant',
  'aria-atomic',
  'aria-autocomplete',
  'aria-braillelabel',
  'aria-brailleroledescription',
  'aria-busy',
  'aria-checked',
  'aria-colcount',
  'aria-colindex',
  'aria-colindextext',
  'aria-colspan',
  'aria-controls',
  'aria-current',
  'aria-describedby',
  'aria-description',
  'aria-details',
  'aria-disabled',
  'aria-dropeffect',
  'aria-errormessage',
  'aria-expanded',
  'aria-flowto',
  'aria-grabbed',
  'aria-haspopup',
  'aria-hidden',
  'aria-invalid',
  'aria-keyshortcuts',
  'aria-label',
  'aria-labelledby',
  'aria-level',
  'aria-live',
  'aria-modal',
  'aria-multiline',
  'aria-multiselectable',
  'aria-orientation',
  'aria-owns',
  'aria-placeholder',
  'aria-posinset',
  'aria-pressed',
  'aria-readonly',
  'aria-relevant',
  'aria-required',
  'aria-roledescription',
  'aria-rowcount',
  'aria-rowindex',
  'aria-rowindextext',
  'aria-rowspan',
  'aria-selected',
  'aria-setsize',
  'aria-sort',
  'aria-valuemax',
  'aria-valuemin',
  'aria-valuenow',
  'aria-valuetext',
];

const ariaRoleNames: readonly string[] = [
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'comment',
  'complementary',
  'contentinfo',
  'definition',
  'deletion',
  'dialog',
  'directory',
  'document',
  'emphasis',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'insertion',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'mark',
  'marquee',
  'math',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'meter',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'strong',
  'subscript',
  'suggestion',
  'superscript',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'time',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
  // Digital Publishing (DPUB-ARIA) roles.
  'doc-abstract',
  'doc-acknowledgments',
  'doc-afterword',
  'doc-appendix',
  'doc-backlink',
  'doc-biblioentry',
  'doc-bibliography',
  'doc-biblioref',
  'doc-chapter',
  'doc-colophon',
  'doc-conclusion',
  'doc-cover',
  'doc-credit',
  'doc-credits',
  'doc-dedication',
  'doc-endnote',
  'doc-endnotes',
  'doc-epigraph',
  'doc-epilogue',
  'doc-errata',
  'doc-example',
  'doc-footnote',
  'doc-foreword',
  'doc-glossary',
  'doc-glossref',
  'doc-index',
  'doc-introduction',
  'doc-noteref',
  'doc-notice',
  'doc-pagebreak',
  'doc-pagefooter',
  'doc-pageheader',
  'doc-pagelist',
  'doc-part',
  'doc-preface',
  'doc-prologue',
  'doc-pullquote',
  'doc-qna',
  'doc-subtitle',
  'doc-tip',
  'doc-toc',
  // Graphics-ARIA roles.
  'graphics-document',
  'graphics-object',
  'graphics-symbol',
];

const maxSuggestionDistance = 2;

const validAttributeNames: ReadonlySet<string> = new Set(ariaAttributeNames);
const validRoleNames: ReadonlySet<string> = new Set(ariaRoleNames);

function editDistance(first: string, second: string): number {
  let previousRow = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let row = 1; row <= first.length; row++) {
    const currentRow = [row];
    for (let column = 1; column <= second.length; column++) {
      const substitutionCost = first[row - 1] === second[column - 1] ? 0 : 1;
      currentRow.push(
        Math.min(previousRow[column] + 1, currentRow[column - 1] + 1, previousRow[column - 1] + substitutionCost),
      );
    }
    previousRow = currentRow;
  }
  return previousRow[second.length];
}

// The one valid name closest to the misspelling; a tie at the best distance has no clear answer.
function closestName(candidates: readonly string[], misspelled: string): string | undefined {
  let best: string | undefined;
  let bestDistance = maxSuggestionDistance + 1;
  let isTied = false;
  for (const candidate of candidates) {
    const distance = editDistance(misspelled, candidate);
    if (distance > maxSuggestionDistance) continue;
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
      isTied = false;
    } else if (distance === bestDistance) {
      isTied = true;
    }
  }
  return isTied ? undefined : best;
}

function closestAttributeName(misspelled: string): string | undefined {
  return closestName(ariaAttributeNames, misspelled);
}

function closestRoleName(misspelled: string): string | undefined {
  return closestName(ariaRoleNames, misspelled);
}

export { validAttributeNames, validRoleNames, closestAttributeName, closestRoleName };
