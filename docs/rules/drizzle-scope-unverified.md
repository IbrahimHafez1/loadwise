---
id: drizzle-scope-unverified
title: drizzle-scope-unverified
description: "A Drizzle operation lacks the row scope required by the declared policy."
checker: security
group: "Rules"
impact: high
fixable: inline
---

## What it flags

A Drizzle query on a table listed in `drizzleScopes` does not prove the configured predicate, projection or write data.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "drizzle-scope-unverified": "off" }
}
```
