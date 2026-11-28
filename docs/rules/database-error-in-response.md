---
id: database-error-in-response
title: database-error-in-response
description: "An HTTP response includes a raw database error message."
checker: security
group: "Rules"
impact: medium
fixable: inline
---

## What it flags

A 5xx response sends a raw database error, or its message, caught from a database call. Driver messages reveal table, column and constraint names; log the error and return a generic message. Express error middleware is contextual.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "database-error-in-response": "off" }
}
```
