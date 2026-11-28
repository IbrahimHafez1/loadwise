---
id: dom-layout-thrashing
title: dom-layout-thrashing
description: "A loop reads layout metrics and mutates DOM styles or classes, forcing a reflow on each iteration."
checker: performance
group: "Source checks"
impact: medium
fixable: manual
---

## What it flags

A loop reads layout metrics and mutates DOM styles or classes, forcing a reflow on each iteration.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "dom-layout-thrashing": "off" }
}
```
