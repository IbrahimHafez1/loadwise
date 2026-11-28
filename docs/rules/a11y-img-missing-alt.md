---
id: a11y-img-missing-alt
title: a11y-img-missing-alt
description: "An image has no alt text, so screen readers announce its file name or nothing."
checker: accessibility
group: "Rules"
impact: high
fixable: manual
---

## What it flags

An image has no alt text, so screen readers announce its file name or nothing.

## How to review or fix

Review whether the image is informative, which needs descriptive alt text, or decorative, which needs `alt=""`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "a11y-img-missing-alt": "off" }
}
```
