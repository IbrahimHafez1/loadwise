---
id: migration-set-not-null-scan
title: migration-set-not-null-scan
description: "SET NOT NULL scans the whole table while holding a lock."
checker: reliability
group: "Migration safety"
impact: high
fixable: inline
related: [migration-constraint-not-valid, migration-constraint-without-index]
---

## What it flags

Full-table validation scans, constraints that should be added `NOT VALID` first, and constraints that build an index while blocking writes.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "migration-set-not-null-scan": "off" }
}
```
