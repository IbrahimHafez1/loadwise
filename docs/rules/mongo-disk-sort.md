---
id: mongo-disk-sort
title: mongo-disk-sort
description: "A MongoDB sort spilled to disk."
checker: performance
group: "Executed query plans"
impact: medium
fixable: manual
related: [pg-disk-sort]
---

## What it flags

At least 1,024 KiB of disk use by a PostgreSQL sort participant, including a reported incremental-sort group peak, or at least 1 MiB of spill or eight spills on a MongoDB sort.

## How to review or fix

Check whether earlier filtering or an index can reduce sorting work.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "mongo-disk-sort": "off" }
}
```
