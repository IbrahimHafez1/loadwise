---
id: queue-add-in-loop
title: queue-add-in-loop
description: "A job queue add runs once per item instead of one addBulk."
checker: performance
group: "Source checks"
impact: high
fixable: inline
---

## What it flags

`queue.add` on a recognized job queue runs once per item, one Redis round trip each.

## How to review or fix

Collect the jobs and call `addBulk`, unless a later job needs the earlier job's result or id.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "queue-add-in-loop": "off" }
}
```
