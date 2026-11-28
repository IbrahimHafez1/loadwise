---
id: prisma-raw-unsafe-dynamic
title: prisma-raw-unsafe-dynamic
description: "Dynamic SQL text reaches an unsafe Prisma raw-query method."
checker: security
group: "Rules"
impact: critical
fixable: manual
---

## What it flags

`$queryRawUnsafe`, `$executeRawUnsafe` or `Prisma.raw` receives SQL text built from a runtime value.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "prisma-raw-unsafe-dynamic": "off" }
}
```
