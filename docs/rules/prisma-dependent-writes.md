---
id: prisma-dependent-writes
title: prisma-dependent-writes
description: "Adjacent Prisma creates pass a value from the first record into the next write."
checker: reliability
group: "Source rules"
impact: high
fixable: inline
---

## What it flags

Adjacent creates pass a value from the first record into the next write. Explicit single-key nested `connect` can use a custom unique field when generated types confirm a relation. Direct scalar assignments currently recognize `parent.id` going into a field ending in `Id` or `_id`. Other scalar foreign-key conventions can be missed. If both writes must succeed together, consider a nested write or an appropriate transaction.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "prisma-dependent-writes": "off" }
}
```
