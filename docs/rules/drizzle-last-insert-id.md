---
id: drizzle-last-insert-id
title: drizzle-last-insert-id
description: "A MySQL insert is followed by an extra query for its generated ID."
checker: performance
group: "Async work and sorting"
impact: medium
fixable: inline
---

## What it flags

A MySQL insert is followed by a separate query for the last generated ID.

## How to review or fix

Review using the insert result directly, especially when the database handle uses a connection pool.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "drizzle-last-insert-id": "off" }
}
```
