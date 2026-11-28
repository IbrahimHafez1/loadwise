---
id: reflected-xss-response
title: reflected-xss-response
description: "An HTML response reflects request data without recognized escaping."
checker: security
group: "Rules"
impact: low
fixable: manual
---

## What it flags

Request data is interpolated into an HTML string sent with `res.send`. Contextual only in this version.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "reflected-xss-response": "off" }
}
```
