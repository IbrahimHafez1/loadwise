---
id: api-enum-value-removed
title: api-enum-value-removed
description: "An enum value or string-literal option that clients could send was removed."
checker: reliability
group: "API contract safety"
impact: high
fixable: manual
---

## What it flags

An enum value or string-literal option that requests (or, in GraphQL, any client) can no longer use.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "api-enum-value-removed": "off" }
}
```
