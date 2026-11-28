---
id: known-reads-awaited-serially
title: known-reads-awaited-serially
description: "Two independent reads from a configured parallelReads group are awaited one after the other."
checker: performance
group: "Async work and sorting"
impact: medium
fixable: inline
---

## What it flags

Two adjacent awaited reads come from a project-configured `parallelReads` group and the second call is independent of the first result in a supported straight-line shape.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "known-reads-awaited-serially": "off" }
}
```
