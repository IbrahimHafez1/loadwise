---
id: migration-constraint-without-index
title: migration-constraint-without-index
description: "A unique or primary key constraint builds its index while blocking writes."
checker: reliability
group: "Migration safety"
impact: high
fixable: inline
related: [migration-set-not-null-scan, migration-constraint-not-valid]
---

## What it flags

Full-table validation scans, constraints that should be added `NOT VALID` first, and constraints that build an index while blocking writes.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "migration-constraint-without-index": "off" }
}
```
