---
id: a11y-clickable-non-interactive
title: a11y-clickable-non-interactive
description: "A click handler sits on a non-interactive element without a role and keyboard support, so keyboard users cannot activate it."
checker: accessibility
group: "Rules"
impact: high
fixable: manual
---

## What it flags

A click handler sits on a non-interactive element without a role and keyboard support, so keyboard users cannot activate it.

## How to review or fix

Review whether a `<button>` or `<a>` can replace the element, or whether it needs a role, `tabIndex` and key handler. Handlers that only stop propagation are accepted.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "a11y-clickable-non-interactive": "off" }
}
```
