---
id: graphql-n-plus-one-resolver
title: graphql-n-plus-one-resolver
description: "A GraphQL field resolver executes a database or HTTP query per parent item without DataLoader batching."
checker: performance
group: "Source checks"
impact: high
fixable: manual
---

## What it flags

A GraphQL field resolver executes a database or HTTP query per parent item without `DataLoader` `.load()` batching.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "graphql-n-plus-one-resolver": "off" }
}
```
