---
id: query-mutates-state
title: query-mutates-state
description: "A method marked @maintainabilityQuery writes through this."
checker: maintainability
group: "What gets checked"
impact: medium
fixable: manual
---

## What it flags

A JS/TS class instance method marked `/** @maintainabilityQuery */` writes directly through `this`. Assignments, increments, deletes and destructuring writes are covered. Mutations through aliases or arbitrary helper calls require review.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "query-mutates-state": "off" }
}
```
