---
id: api-type-changed
title: api-type-changed
description: "A field or parameter changed type, or a GraphQL type changed nullability in a breaking direction."
checker: reliability
group: "API contract safety"
impact: high
fixable: manual
---

## What it flags

A field or parameter whose type changed, or a GraphQL type that became nullable (output) or non-null (input).

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "api-type-changed": "off" }
}
```
