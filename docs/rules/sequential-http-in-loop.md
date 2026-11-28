---
id: sequential-http-in-loop
title: sequential-http-in-loop
description: "Independent HTTP requests are awaited one at a time inside a loop."
checker: performance
group: "Source checks"
impact: high
fixable: inline
---

## What it flags

Independent HTTP requests are awaited one at a time inside a loop.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "sequential-http-in-loop": "off" }
}
```
