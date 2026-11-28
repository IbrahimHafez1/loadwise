---
id: csharp-disposable-without-using
title: csharp-disposable-without-using
description: "A C# stream, connection or other IDisposable is created without using, so an exception leaks it."
checker: reliability
group: "Source rules"
impact: medium
fixable: manual
---

## What it flags

A stream or database connection is created without `using`, so an exception skips `Dispose()`. Variables that are returned, stored, handed to another object or disposed in a later `finally` are accepted.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "csharp-disposable-without-using": "off" }
}
```
