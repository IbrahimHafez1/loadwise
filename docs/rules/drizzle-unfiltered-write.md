---
id: drizzle-unfiltered-write
title: drizzle-unfiltered-write
description: "A Drizzle update or delete executes without an effective where clause."
checker: reliability
group: "Source rules"
impact: critical
fixable: inline
---

## What it flags

An executed update/delete has no effective predicate in a recognized direct chain. An intentional whole-table maintenance operation can legitimately match.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "drizzle-unfiltered-write": "off" }
}
```
