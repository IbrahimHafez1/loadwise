---
id: react-state-mutated-in-place
title: react-state-mutated-in-place
description: "A useState value is mutated in place and passed to its own setter, so React sees the same reference and skips the re-render."
checker: reliability
group: "Source rules"
impact: high
fixable: manual
---

## What it flags

A `useState` value is changed in place (`push`, `splice`, `sort`, `reverse`, an assignment to a property or index) and then passed to its own setter. React compares by reference, so the re-render is skipped.

## How to review or fix

Set a copy instead.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "react-state-mutated-in-place": "off" }
}
```
