---
id: a11y-missing-form-label
title: a11y-missing-form-label
description: "A form control has no label, so screen readers announce it without its purpose."
checker: accessibility
group: "Rules"
impact: high
fixable: manual
---

## What it flags

A form control has no label, so screen readers announce it without its purpose.

## How to review or fix

Review how the control is named: a wrapping `<label>`, a `<label for>` matching its id, or aria-label. A placeholder is not a label.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "a11y-missing-form-label": "off" }
}
```
