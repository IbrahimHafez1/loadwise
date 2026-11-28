---
id: unbounded-list-query
title: unbounded-list-query
description: "A request handler returns query results without an apparent row limit."
checker: performance
group: "Source checks"
impact: high
fixable: manual
---

## What it flags

A Prisma, TypeORM, Drizzle or pg list query has no `take` or `limit` and its rows are returned from a request handler. Unique-key lookups are skipped; one-hop service findings require contextual mode. A page size taken straight from request input with no upper cap is reported too.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "unbounded-list-query": "off" }
}
```
