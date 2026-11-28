---
id: a11y-button-missing-type
title: a11y-button-missing-type
description: "A button inside a form has no type, so it submits the form even when it only meant to run a handler."
checker: accessibility
group: "Rules"
impact: medium
fixable: inline
---

## What it flags

A button inside a form (or tied to one with `form=`) has no `type`, so it submits.

## How to review or fix

Review whether it should submit (`type="submit"`) or only run a click handler (`type="button"`).

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "a11y-button-missing-type": "off" }
}
```
