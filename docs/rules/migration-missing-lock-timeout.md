---
id: migration-missing-lock-timeout
title: migration-missing-lock-timeout
description: "A migration statement takes a lock with no lock_timeout set."
checker: reliability
group: "Migration safety"
impact: high
fixable: inline
---

## What it flags

A locking statement with no `lock_timeout`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "migration-missing-lock-timeout": "off" }
}
```
