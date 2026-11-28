---
id: file-handle-not-closed
title: file-handle-not-closed
description: "A FileHandle from fs/promises open() is not closed on every path, leaking a file descriptor."
checker: reliability
group: "Source rules"
impact: high
fixable: inline
---

## What it flags

A `FileHandle` from `fs/promises` `open()` is not closed in `finally`, so an error before `close()` leaks the file descriptor. Handles that are returned, stored, passed on or turned into a stream are accepted.

## How to review or fix

Confirm nothing else closes it, then close it in `finally` or use `await using`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "file-handle-not-closed": "off" }
}
```
