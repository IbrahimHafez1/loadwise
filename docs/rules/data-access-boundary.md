---
id: data-access-boundary
title: data-access-boundary
description: "A file outside the approved paths imports a configured database driver or ORM."
checker: maintainability
group: "What gets checked"
impact: medium
fixable: manual
---

## What it flags

A JS/TS file outside the approved paths imports a configured database driver or ORM module at runtime. Static imports, re-exports, `import x = require()`, literal dynamic imports and unshadowed `require()` calls are checked. The policy is opt-in via `dataAccess`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "data-access-boundary": "off" }
}
```
