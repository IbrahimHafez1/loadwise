---
id: error-stack-in-response
title: error-stack-in-response
description: "An HTTP response includes an internal error stack."
checker: security
group: "Rules"
impact: medium
fixable: inline
---

## What it flags

An error `.stack` is written into a response body. A whole error object is contextual. Code that runs only outside production is clean.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "error-stack-in-response": "off" }
}
```
