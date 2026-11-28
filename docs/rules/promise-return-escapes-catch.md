---
id: promise-return-escapes-catch
title: promise-return-escapes-catch
description: "Returning a promise directly from a protected try block can bypass its catch on rejection."
checker: reliability
group: "Source rules"
impact: high
fixable: inline
---

## What it flags

An async function returns a typed promise directly from the `try` block of a `try`/`catch`. A rejection can bypass that catch.

## How to review or fix

Use `return await` when the catch owns the failure.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "promise-return-escapes-catch": "off" }
}
```
