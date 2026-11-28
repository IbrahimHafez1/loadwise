---
id: stream-pipe-unhandled-error
title: stream-pipe-unhandled-error
description: "A stream is piped with .pipe() and no error handling, so a stream error can crash the process or leak the file."
checker: reliability
group: "Source rules"
impact: high
fixable: inline
---

## What it flags

`.pipe()` on a Node stream with no `error` listener and no `pipeline`/`finished` in the function, so a stream error crashes the process or leaks the file and socket. RxJS pipes are skipped; a stream known only by its name is contextual.

## How to review or fix

Fix (review): `await pipeline(...)` from `node:stream/promises`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "stream-pipe-unhandled-error": "off" }
}
```
