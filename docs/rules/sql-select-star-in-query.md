---
id: sql-select-star-in-query
title: sql-select-star-in-query
description: "A raw SQL query selects every column with SELECT * instead of the columns it needs."
checker: performance
group: "Source checks"
impact: low
fixable: manual
---

## What it flags

A raw SQL query selects every column with SELECT * instead of the columns it needs.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "sql-select-star-in-query": "off" }
}
```
