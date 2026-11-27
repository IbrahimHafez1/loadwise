import assert from 'node:assert/strict';

// The element a test expects at an index; fails with the index and length when the array is
// shorter.
export function elementAt<Element>(items: readonly Element[], index: number): Element {
  const found = items[index];
  assert.ok(found !== undefined, `expected an element at index ${index} of ${items.length}`);
  return found;
}
