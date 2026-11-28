---
id: double-type-assertion
title: double-type-assertion
description: "A value is cast through unknown or any to a second type, bypassing the type checker."
checker: maintainability
group: "What gets checked"
impact: low
fixable: manual
---

## What it flags

`value as unknown as T` and `value as any as T`, which turn off the type checker for that value. Declaration files, fixtures, docs, examples, generated and vendored code are skipped.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "double-type-assertion": "off" }
}
```
