---
id: dom-unthrottled-scroll-resize
title: dom-unthrottled-scroll-resize
description: "A scroll, resize, mousemove, wheel or touch listener runs unthrottled work (or is non-passive) on the main thread."
checker: performance
group: "Source checks"
impact: low
fixable: inline
---

## What it flags

A scroll, resize, mousemove, wheel or touch listener runs unthrottled work (or is non-passive) on the main thread.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "dom-unthrottled-scroll-resize": "off" }
}
```
