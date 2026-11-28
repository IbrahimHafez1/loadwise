---
id: go-sql-query-in-loop
title: go-sql-query-in-loop
description: "A Go database query executes inside a loop instead of batching."
checker: performance
group: "Polyglot source checks"
impact: high
fixable: manual
---

## What it flags

A Go database query executes inside a loop instead of batching.

## Example

A Go `sql.DB` or ORM query executes inside a `for` loop instead of batching.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "go-sql-query-in-loop": "off" }
}
```
