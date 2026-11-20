'use strict';

// Dismissed findings live in the workspace state, never in the user's code. A finding is matched by file, rule and
// the trimmed text of its flagged line, so it stays hidden across rescans and line shifts and returns once that
// line changes. An entry without line text hides the rule for the whole file.
const stateKey = 'loadwise.dismissed';

function keyOf({ file, ruleId, lineText }) {
  return JSON.stringify([file, ruleId, lineText ?? null]);
}

function createDismissals(memento) {
  let keys;
  function entries() {
    return memento.get(stateKey, []);
  }
  function save(next) {
    keys = undefined;
    return memento.update(stateKey, next);
  }
  return {
    entries,
    has(site) {
      keys ??= new Set(entries().map(keyOf));
      return keys.has(keyOf(site)) || keys.has(keyOf({ file: site.file, ruleId: site.ruleId }));
    },
    add(entry) {
      const key = keyOf(entry);
      return save([...entries().filter((existing) => keyOf(existing) !== key), entry]);
    },
    remove(removed) {
      const gone = new Set(removed.map(keyOf));
      return save(entries().filter((entry) => !gone.has(keyOf(entry))));
    },
  };
}

module.exports = { createDismissals };
