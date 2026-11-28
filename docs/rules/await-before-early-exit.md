---
id: await-before-early-exit
title: await-before-early-exit
description: "An awaited read runs before a guard that returns or throws without using its result."
checker: performance
group: "Async work and sorting"
impact: medium
fixable: inline
---

## What it flags

An awaited ORM or HTTP read is followed directly by an `if` that returns or throws without using the result, so a request the guard rejects still pays the round trip. Writes, `OrThrow` reads and POSTs are left alone. The fix moves the guard above the await only when it has no calls and reads only parameters and earlier constants.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "await-before-early-exit": "off" }
}
```
