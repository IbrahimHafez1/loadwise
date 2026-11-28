---
id: migration-constraint-not-valid
title: migration-constraint-not-valid
description: "A constraint is added and validated in one step instead of NOT VALID first."
checker: reliability
group: "Migration safety"
impact: high
fixable: inline
related: [migration-set-not-null-scan, migration-constraint-without-index]
---

## What it flags

Full-table validation scans, constraints that should be added `NOT VALID` first, and constraints that build an index while blocking writes.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "migration-constraint-not-valid": "off" }
}
```
