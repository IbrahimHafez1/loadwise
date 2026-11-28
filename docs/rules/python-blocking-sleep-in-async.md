---
id: python-blocking-sleep-in-async
title: python-blocking-sleep-in-async
description: "A blocking time.sleep call runs inside a Python async def function."
checker: performance
group: "Polyglot source checks"
impact: high
fixable: manual
---

## What it flags

A blocking time.sleep call runs inside a Python async def function.

## Example

`time.sleep(...)` inside an `async def` function, in a module that imports `time`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "python-blocking-sleep-in-async": "off" }
}
```
