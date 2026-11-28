---
id: session-memory-store
title: session-memory-store
description: "An express-session middleware has no store, so sessions live in process memory."
checker: performance
group: "Source checks"
impact: high
fixable: manual
---

## What it flags

`express-session` or `@fastify/session` is set up without a `store`, so sessions live in process memory: they leak, are lost on restart and are not shared across instances.

## How to review or fix

Pass a shared store such as connect-redis or connect-pg-simple.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "session-memory-store": "off" }
}
```
