---
id: a11y-viewport-zoom-disabled
title: a11y-viewport-zoom-disabled
description: "The viewport meta tag disables zoom, so people with low vision cannot enlarge the page."
checker: accessibility
group: "Rules"
impact: high
fixable: manual
---

## What it flags

The viewport meta tag disables zoom, so people with low vision cannot enlarge the page.

## How to review or fix

Review whether the zoom limit is needed. Remove `user-scalable=no` and keep maximum-scale at 2 or more.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "a11y-viewport-zoom-disabled": "off" }
}
```
