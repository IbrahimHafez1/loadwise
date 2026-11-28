---
id: redis-command-in-loop
title: redis-command-in-loop
description: "A per-key Redis command runs once per loop iteration."
checker: performance
group: "Source checks"
impact: high
fixable: inline
---

## What it flags

A per-key Redis or Valkey command on a repeated path.

## How to review or fix

Use a multi-key command or a bounded pipeline if cluster slots, ordering and error handling permit it. SCAN cursor loops are skipped.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "redis-command-in-loop": "off" }
}
```
