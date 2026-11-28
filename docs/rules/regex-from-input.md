---
id: regex-from-input
title: regex-from-input
description: "Request input supplies a regular expression pattern without recognized escaping."
checker: security
group: "Rules"
impact: medium
fixable: manual
---

## What it flags

Request text becomes a regular expression through `RegExp`, `match`/`matchAll`/`search` on a string, or a `$regex` operand, without escaping.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "regex-from-input": "off" }
}
```
