---
id: return-in-finally
title: return-in-finally
description: "Returning from finally can replace a pending return value or suppress a thrown error."
checker: reliability
group: "Source rules"
impact: high
fixable: manual
---

## What it flags

A return in `finally` can replace an earlier return value or suppress a thrown error.

## How to review or fix

Keep cleanup in `finally` and return from `try`, `catch`, or after the statement.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "return-in-finally": "off" }
}
```
