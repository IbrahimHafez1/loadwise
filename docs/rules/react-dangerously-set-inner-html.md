---
id: react-dangerously-set-inner-html
title: react-dangerously-set-inner-html
description: "dangerouslySetInnerHTML receives HTML that is not a constant or sanitized."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

dangerouslySetInnerHTML receives HTML that is not a constant or sanitized.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "react-dangerously-set-inner-html": "off" }
}
```
