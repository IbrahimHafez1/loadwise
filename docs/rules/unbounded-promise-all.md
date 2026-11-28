---
id: unbounded-promise-all
title: unbounded-promise-all
description: "Promise.all runs over an unbounded collection without a concurrency limit, risking memory spikes or downstream saturation."
checker: reliability
group: "Source rules"
impact: high
fixable: manual
---

## What it flags

`Promise.all` runs over an unbounded collection without a concurrency limit (`p-limit`, `pMap`, `PromisePool`, or chunking).

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "unbounded-promise-all": "off" }
}
```
