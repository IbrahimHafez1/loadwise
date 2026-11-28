---
id: a11y-invalid-aria
title: a11y-invalid-aria
description: "An ARIA attribute or role is misspelled or invalid, so assistive technology ignores it."
checker: accessibility
group: "Rules"
impact: high
fixable: manual
---

## What it flags

An ARIA attribute or role is misspelled or invalid, so assistive technology ignores it.

## How to review or fix

Review the misspelled ARIA attribute or role against the WAI-ARIA names and use the suggested one.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "a11y-invalid-aria": "off" }
}
```
