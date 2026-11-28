---
id: redis-keys-scan
title: redis-keys-scan
description: "A trace shows a Redis KEYS command scanning the keyspace."
checker: performance
group: "Trace checks in other languages and databases"
impact: high
fixable: manual
---

## What it flags

One Redis or Valkey `KEYS` command can scan the keyspace. For incremental iteration, account for duplicates and keys changing between `SCAN` calls.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "redis-keys-scan": "off" }
}
```
