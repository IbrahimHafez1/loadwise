---
id: a11y-positive-tabindex
title: a11y-positive-tabindex
description: "A positive tabindex reorders keyboard focus away from the visual order."
checker: accessibility
group: "Rules"
impact: medium
fixable: manual
---

## What it flags

A positive tabindex reorders keyboard focus away from the visual order.

## How to review or fix

Review whether the focus order can come from the markup order, then use `tabIndex` 0 or -1.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "a11y-positive-tabindex": "off" }
}
```
