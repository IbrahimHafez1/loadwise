---
id: redis-incr-then-expire
title: redis-incr-then-expire
description: "A Redis counter increment and its expire on the same key are two round trips and not atomic."
checker: reliability
group: "Source rules"
impact: medium
fixable: inline
---

## What it flags

An `incr`, `incrby` or `hincrby` followed by `expire` or `pexpire` on the same key and client takes two round trips and is not atomic: a crash between them leaves the counter without a TTL.

## How to review or fix

Send both in one `multi()` (with `NX` on Redis 7+) or a Lua script.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "redis-incr-then-expire": "off" }
}
```
