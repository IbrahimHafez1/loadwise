---
id: mongo-deep-skip
title: mongo-deep-skip
description: "A MongoDB query skips past many documents to return a page."
checker: performance
group: "Executed query plans"
impact: high
fixable: manual
related: [pg-deep-offset]
---

## What it flags

At least ten times as many entries walked as returned and at least 10,000 skipped per execution. For sequential pages, keyset pagination needs a stable ordering with a unique tie-breaker.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "mongo-deep-skip": "off" }
}
```
