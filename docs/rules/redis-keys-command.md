---
id: redis-keys-command
title: redis-keys-command
description: "A Redis KEYS call blocks the server while it scans the keyspace."
checker: performance
group: "Source checks"
impact: high
fixable: inline
---

## What it flags

`keys()` on a recognized ioredis or node-redis client blocks Redis while it scans the keyspace.

## How to review or fix

Iterate with `SCAN` (`scanStream` or `scanIterator`) after reviewing duplicate keys, iteration order and concurrent writes.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "redis-keys-command": "off" }
}
```
