---
id: a11y-iframe-missing-title
title: a11y-iframe-missing-title
description: "An iframe has no title, so screen readers cannot say what it contains."
checker: accessibility
group: "Rules"
impact: medium
fixable: manual
---

## What it flags

An iframe has no title, so screen readers cannot say what it contains.

## How to review or fix

Review what the embedded content is and give the iframe a `title` that says so.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "a11y-iframe-missing-title": "off" }
}
```
