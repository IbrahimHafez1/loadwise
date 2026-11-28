---
id: cors-origin-regex-unanchored
title: cors-origin-regex-unanchored
description: "A CORS origin regex also accepts look-alike hosts."
checker: security
group: "Rules"
impact: medium
fixable: inline
---

## What it flags

CORS `origin` regexes, and regex `.test` calls on the request origin, whose host can be prefixed (no `^`, `//` or `\.` before it), extended (no `$` after it) or has an unescaped dot. URL values passed to `new RegExp` count too. Without credentials it is contextual. The fix anchors and escapes a single-branch literal and needs review.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "cors-origin-regex-unanchored": "off" }
}
```
