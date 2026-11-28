---
id: pg-deep-offset
title: pg-deep-offset
description: "A PostgreSQL plan walks past many rows with OFFSET to return a page."
checker: performance
group: "Executed query plans"
impact: high
fixable: manual
related: [mongo-deep-skip]
---

## What it flags

At least ten times as many entries walked as returned and at least 10,000 skipped per execution. For sequential pages, keyset pagination needs a stable ordering with a unique tie-breaker.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "pg-deep-offset": "off" }
}
```
