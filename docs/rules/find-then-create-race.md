---
id: find-then-create-race
title: find-then-create-race
description: "A lookup by key is followed by an insert with that key, with no unique constraint to stop duplicates."
checker: reliability
group: "Source rules"
impact: high
fixable: manual
---

## What it flags

A Prisma or TypeORM lookup by one key is followed in the same function by an insert with the same key, and the schema shows no unique constraint on it.

## How to review or fix

Add the constraint and catch the violation (Prisma P2002, Postgres 23505) or use `upsert` / `ON CONFLICT`. Without a readable schema the finding is contextual; serializable transactions, locks and handled duplicates are skipped.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "find-then-create-race": "off" }
}
```
