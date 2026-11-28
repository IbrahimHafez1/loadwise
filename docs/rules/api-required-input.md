---
id: api-required-input
title: api-required-input
description: "A request field, parameter or GraphQL argument is new and required, or became required."
checker: reliability
group: "API contract safety"
impact: high
fixable: manual
---

## What it flags

A request field, parameter, GraphQL argument or input field that is new and required, or changed from optional to required.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "api-required-input": "off" }
}
```
