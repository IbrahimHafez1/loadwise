---
id: drizzle-sql-raw-dynamic
title: drizzle-sql-raw-dynamic
description: "A dynamic SQL fragment reaches Drizzle without parameter binding."
checker: security
group: "Rules"
impact: critical
fixable: manual
---

## What it flags

`sql.raw` from drizzle-orm receives text built from a runtime value.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "drizzle-sql-raw-dynamic": "off" }
}
```
