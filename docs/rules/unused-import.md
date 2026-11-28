---
id: unused-import
title: unused-import
description: "An imported name is never used in the file."
checker: maintainability
group: "What gets checked"
impact: low
fixable: inline
---

## What it flags

An imported name is never used in the file. Type positions, `typeof`, re-exports, decorators, JSDoc references and the `React` import under the classic JSX runtime count as use, and side-effect imports are never reported. Skipped when `noUnusedLocals` is on, since the compiler reports it, when an eslint-disable comment names `no-unused-vars` or `@typescript-eslint/no-unused-vars`, and in codemod `*.input` / `*.output` fixtures, fixture folders, docs, examples, vendored code and assets. The fix removes the name; removing a whole declaration is marked for review because the module may have side effects.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "unused-import": "off" }
}
```
