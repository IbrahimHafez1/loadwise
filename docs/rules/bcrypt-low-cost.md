---
id: bcrypt-low-cost
title: bcrypt-low-cost
description: "A bcrypt password hash uses a work factor below the recommended minimum."
checker: security
group: "Rules"
impact: medium
fixable: inline
---

## What it flags

A literal bcrypt cost below 10 passed to `hash`, `hashSync`, `genSalt` or `genSaltSync`.

## How to review or fix

Use 10 or higher and measure the hashing time; the fix writes 12.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "bcrypt-low-cost": "off" }
}
```
