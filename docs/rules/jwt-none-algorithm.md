---
id: jwt-none-algorithm
title: jwt-none-algorithm
description: "JWT signing or verification allows an unsigned token."
checker: security
group: "Rules"
impact: critical
fixable: inline
---

## What it flags

The `none` algorithm appears in an `algorithms` list or a `sign` call, so unsigned tokens are accepted or produced.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "jwt-none-algorithm": "off" }
}
```
