---
id: orm-deep-offset
title: orm-deep-offset
description: "A list query pages with a large or unbounded offset, so the database reads and discards every skipped row."
checker: performance
group: "Source checks"
impact: high
fixable: manual
---

## What it flags

A Prisma `skip`, TypeORM, Sequelize, Mongoose, Drizzle or Knex offset, or a pg `OFFSET $n`, takes request input with no upper bound, or is a literal above 10000. The database reads and discards every skipped row; use keyset (cursor) pagination. One-hop service calls and schemas whose limit cannot be read are contextual.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "orm-deep-offset": "off" }
}
```
