'use strict';

// Text edit that deletes one item of a comma-separated list (object properties, array elements).
// Returns nothing when the list has no other item or a comment sits where the item and its comma go.
function removeListItem(items, item) {
  if (items.length < 2) return;
  const text = item.getSourceFile().text;
  const index = items.indexOf(item);
  const isLast = index === items.length - 1;
  const start = isLast ? items[index - 1].end : item.getStart();
  const end = isLast ? item.end : items[index + 1].getStart();
  if (/\/\/|\/\*/.test(text.slice(start, end))) return;
  return { start, end, text: '' };
}

module.exports = { removeListItem };
