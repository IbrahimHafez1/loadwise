---
id: api-removed-operation
title: api-removed-operation
description: "An OpenAPI operation or a GraphQL Query, Mutation or Subscription field was removed."
checker: reliability
group: "API contract safety"
impact: critical
fixable: manual
---

## What it flags

An OpenAPI path and method, or a GraphQL `Query`, `Mutation` or `Subscription` field, that no longer exists.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "api-removed-operation": "off" }
}
```
