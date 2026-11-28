---
id: repeated-db-span
title: repeated-db-span
description: "A trace shows many similar sibling database calls under one parent."
checker: performance
group: "Trace checks in other languages and databases"
impact: high
fixable: manual
---

## What it flags

Five similar sibling DB calls by default, grouped by resource, trace, parent and recorded database target. SQL statements, query summaries, operation/collection pairs and recognized DynamoDB `GetItem` events can provide signatures. Namespace-only MongoDB or DynamoDB groups call for inspection of the actual predicates.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "repeated-db-span": "off" }
}
```
