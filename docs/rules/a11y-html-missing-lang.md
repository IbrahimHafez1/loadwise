---
id: a11y-html-missing-lang
title: a11y-html-missing-lang
description: "The html element has no lang attribute, so screen readers guess the pronunciation."
checker: accessibility
group: "Rules"
impact: medium
fixable: manual
---

## What it flags

The html element has no lang attribute, so screen readers guess the pronunciation.

## How to review or fix

Review which language the page is written in and set `lang` to it.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "a11y-html-missing-lang": "off" }
}
```
