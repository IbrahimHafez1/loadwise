---
id: pool-without-connection-timeout
title: pool-without-connection-timeout
description: "A pg Pool or Client sets no connectionTimeoutMillis, so its default of 0 waits for a connection forever."
checker: reliability
group: "Source rules"
impact: medium
fixable: manual
---

## What it flags

A `pg` `Pool` or `Client` is created without `connectionTimeoutMillis`; its default of `0` waits for a connection forever, so an exhausted pool or unreachable database hangs the caller. Other drivers (mysql2, knex, MongoDB, ioredis) are not checked.

## How to review or fix

Set a few seconds.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "pool-without-connection-timeout": "off" }
}
```
