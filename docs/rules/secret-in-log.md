---
id: secret-in-log
title: secret-in-log
description: "A log statement can expose a credential, token, or other secret."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

A password, token, key or authorization value is passed to a logger call. Logging a whole request body or headers object is contextual.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "secret-in-log": "off" }
}
```
