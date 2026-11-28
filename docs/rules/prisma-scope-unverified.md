---
id: prisma-scope-unverified
title: prisma-scope-unverified
description: "A Prisma operation lacks the row scope required by the declared policy."
checker: security
group: "Rules"
impact: high
fixable: inline
---

## What it flags

A Prisma read or write on a model listed in `prismaScopes` does not prove the configured scope in its filter, projection or write data.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "prisma-scope-unverified": "off" }
}
```
