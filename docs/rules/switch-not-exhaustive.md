---
id: switch-not-exhaustive
title: switch-not-exhaustive
description: "A switch over a union or enum has no default and misses members, so the missing value leaves the result undefined."
checker: reliability
group: "Source rules"
impact: medium
fixable: manual
---

## What it flags

A `switch` over a union of string or number literals, or an enum, names only some members and has no `default`, and the function then returns nothing for the rest or a variable declared without a value is read afterwards.

## How to review or fix

Add the missing cases, or a `default` that throws.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "switch-not-exhaustive": "off" }
}
```
