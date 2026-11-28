---
id: list-query-overfetch
title: list-query-overfetch
description: "A list query loads large columns or nested relations without a narrow projection."
checker: performance
group: "Source checks"
impact: medium
fixable: manual
---

## What it flags

A Prisma `findMany` or TypeORM `find` without `select` loads `Json`, `Bytes` or text columns, or relations two levels deep. Column checks need a parseable schema; pages up to 100 rows skip them.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "list-query-overfetch": "off" }
}
```
