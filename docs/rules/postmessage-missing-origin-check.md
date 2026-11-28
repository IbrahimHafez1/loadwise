---
id: postmessage-missing-origin-check
title: postmessage-missing-origin-check
description: "postMessage targets '*', or a window message listener reads event.data without checking origin or source."
checker: security
group: "Rules"
impact: medium
fixable: manual
---

## What it flags

postMessage targets '*', or a window message listener reads event.data without checking origin or source.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "postmessage-missing-origin-check": "off" }
}
```
