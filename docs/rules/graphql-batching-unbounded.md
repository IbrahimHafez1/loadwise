---
id: graphql-batching-unbounded
title: graphql-batching-unbounded
description: "GraphQL query batching is enabled without a batch size, query depth, or cost/complexity limit."
checker: security
group: "Rules"
impact: medium
fixable: manual
---

## What it flags

GraphQL query batching is enabled without a batch size, query depth, or cost/complexity limit.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "graphql-batching-unbounded": "off" }
}
```
