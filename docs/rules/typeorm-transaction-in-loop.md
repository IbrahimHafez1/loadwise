---
id: typeorm-transaction-in-loop
title: typeorm-transaction-in-loop
description: "A loop calls a helper that starts one TypeORM transaction per item."
checker: performance
group: "ORM and query integrity checks"
impact: high
fixable: manual
related: [drizzle-query-in-loop, orm-query-in-loop, orm-count-materialization, typeorm-existence-materialization, typeorm-wide-projection]
---

## What it flags

`orm-query-in-loop`, `drizzle-query-in-loop` and `orm-count-materialization` preserve the distinction between building a lazy statement and executing it. Counts with pagination, grouping, joins, hooks or scopes need particular care. TypeORM checks also identify entity reads used only for existence (`typeorm-existence-materialization`), unused wide columns in a direct DTO projection (`typeorm-wide-projection`), and a loop calling a local private helper that starts a transaction (`typeorm-transaction-in-loop`). Before changing a projection or an existence check, verify entity-load side effects. For per-row transactions, check rollback, ordering and error reporting before batching. The adapters recognize specific typed APIs. Custom methods with the same name, raw queries and wrappers often have different semantics.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "typeorm-transaction-in-loop": "off" }
}
```
