---
id: list-count-per-request
title: list-count-per-request
description: "A list endpoint runs a full count query on every request."
checker: performance
group: "Source checks"
impact: medium
fixable: manual
---

## What it flags

A request handler that pages rows also runs a full count (`count`, `findAndCount`, `countDocuments`, `select count(...)`) and returns the total. Cached and first-page-only counts are skipped; counts filtered by an id column, and counts with the same `where` as a list limited to one page (`take`/`limit`), are contextual. A serial count then page is `count-then-page-serial` instead.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "list-count-per-request": "off" }
}
```
