---
id: pg-disk-sort
title: pg-disk-sort
description: "A PostgreSQL sort spilled to disk."
checker: performance
group: "Executed query plans"
impact: medium
fixable: manual
related: [mongo-disk-sort]
---

## What it flags

At least 1,024 KiB of disk use by a PostgreSQL sort participant, including a reported incremental-sort group peak, or at least 1 MiB of spill or eight spills on a MongoDB sort.

## How to review or fix

Check whether earlier filtering or an index can reduce sorting work.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "pg-disk-sort": "off" }
}
```
