---
id: python-sync-requests-in-async
title: python-sync-requests-in-async
description: "A blocking requests HTTP call runs inside a Python async def function."
checker: performance
group: "Polyglot source checks"
impact: high
fixable: manual
---

## What it flags

A blocking requests HTTP call runs inside a Python async def function.

## Example

A `requests.get`, `post`, `put`, `patch`, `delete` or `request` call inside an `async def` function blocks the event loop.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "python-sync-requests-in-async": "off" }
}
```
