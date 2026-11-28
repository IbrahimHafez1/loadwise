---
id: node-sync-crypto-in-async
title: node-sync-crypto-in-async
description: "A synchronous crypto call blocks the event loop inside an async function."
checker: performance
group: "Source checks"
impact: high
fixable: inline
related: [node-sync-process-in-async, node-sync-fs-in-async, node-sync-compression-in-async]
---

## What it flags

A recognized synchronous API blocks an async function. Examples include `readFileSync`, `gzipSync`, `scryptSync` and `execFileSync`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "node-sync-crypto-in-async": "off" }
}
```
