---
id: child-process-without-error-listener
title: child-process-without-error-listener
description: "A spawned child process has no 'error' listener, so a failed spawn crashes the parent process."
checker: reliability
group: "Source rules"
impact: high
fixable: manual
---

## What it flags

A `spawn()` or `fork()` child process (or an `exec`/`execFile` call with no callback) from `child_process` never gets a `child.on('error', ...)` listener and is not passed to other code. A failed spawn, such as a missing binary, emits `'error'` on the next tick and with no listener it crashes the parent process.

## How to review or fix

Add the listener, or wait with `events.once(child, 'exit')`, which rejects on `'error'`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "child-process-without-error-listener": "off" }
}
```
