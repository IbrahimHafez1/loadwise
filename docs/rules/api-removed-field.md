---
id: api-removed-field
title: api-removed-field
description: "A response field, GraphQL type, field, argument or union member, or returned DTO property was removed."
checker: reliability
group: "API contract safety"
impact: high
fixable: manual
---

## What it flags

A response field, GraphQL type, field, argument or union member, or a DTO property returned to clients, that was removed.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "api-removed-field": "off" }
}
```
