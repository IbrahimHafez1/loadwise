---
id: drizzle-write-preflight
title: drizzle-write-preflight
description: "A separate existence check before a Drizzle write can race with another request."
checker: reliability
group: "Source rules"
impact: medium
fixable: inline
---

## What it flags

An existence check immediately precedes a write on the same key.

## How to review or fix

Review the database constraint or affected-row count alongside the intended error response when requests race.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "drizzle-write-preflight": "off" }
}
```
