---
id: code-injection
title: code-injection
description: "Request-controlled input becomes source code evaluated by the application."
checker: security
group: "Rules"
impact: critical
fixable: manual
---

## What it flags

Request data is evaluated as code: `eval`, `new Function`, `vm`, a string timer callback, `require`/`import()` of a request path, or node-serialize.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "code-injection": "off" }
}
```
