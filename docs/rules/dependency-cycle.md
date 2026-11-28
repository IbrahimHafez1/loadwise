---
id: dependency-cycle
title: dependency-cycle
description: "An eager chain of internal imports leads back to the module it started from."
checker: maintainability
group: "What gets checked"
impact: high
fixable: inline
---

## What it flags

An eager internal dependency path returns to its starting module. One ordered example path is shown per strongly connected component. Deferred loads can still be checked against folder boundaries.

## Inline fix

Turns an import whose names are used only as types into `import type`, which removes that edge from the runtime cycle.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "dependency-cycle": "off" }
}
```
