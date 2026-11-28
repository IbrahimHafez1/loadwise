---
id: node-sync-fs-in-async
title: node-sync-fs-in-async
description: "A synchronous fs call blocks the event loop inside an async function."
checker: performance
group: "Source checks"
impact: medium
fixable: inline
related: [node-sync-crypto-in-async, node-sync-process-in-async, node-sync-compression-in-async]
---

## What it flags

A recognized synchronous API blocks an async function. Examples include `readFileSync`, `gzipSync`, `scryptSync` and `execFileSync`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "node-sync-fs-in-async": "off" }
}
```
