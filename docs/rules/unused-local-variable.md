---
id: unused-local-variable
title: unused-local-variable
description: "A local variable is assigned but never read."
checker: maintainability
group: "What gets checked"
impact: low
fixable: inline
---

## What it flags

A `const`, `let` or `var` is declared and never read. Names starting with `_`, destructuring (rest siblings omit keys on purpose), loop and catch variables, exports and files using `eval` or `with` are skipped, as is the whole rule when `noUnusedLocals` is on, a variable under an eslint-disable comment for `no-unused-vars` or `@typescript-eslint/no-unused-vars`, and codemod `*.input` / `*.output` fixtures, fixture folders, docs, examples, vendored code and assets. The fix deletes the declaration only when its initializer has no side effects.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "unused-local-variable": "off" }
}
```
