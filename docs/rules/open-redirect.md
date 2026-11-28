---
id: open-redirect
title: open-redirect
description: "An HTTP redirect destination is controlled by request data."
checker: security
group: "Rules"
impact: medium
fixable: manual
---

## What it flags

A redirect target whose site comes from request data. A fixed origin or an enforced relative-path check can keep the target on site. A Referer target is contextual.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "open-redirect": "off" }
}
```
