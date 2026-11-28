---
id: go-defer-before-error-check
title: go-defer-before-error-check
description: "A Go defer closes a resource before its error is checked, so a failed open dereferences nil."
checker: reliability
group: "Source rules"
impact: high
fixable: manual
---

## What it flags

`defer resp.Body.Close()`, or `defer rows.Close()` after `Query`/`QueryContext`, runs before `err` is checked, so a failed call defers `Close` on a nil value and panics. `os.Open` files are accepted, since `Close` on a nil `*os.File` returns an error instead.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "go-defer-before-error-check": "off" }
}
```
