---
id: typeorm-unused-count
title: typeorm-unused-count
description: "A TypeORM count-and-list query discards its total in immediate tuple destructuring."
checker: performance
group: "Async work and sorting"
impact: medium
fixable: inline
---

## What it flags

A typed TypeORM `findAndCount()`, `findAndCountBy()` or `getManyAndCount()` call returns rows and a count but the awaited destructuring only keeps the rows.

## How to review or fix

Use `find()`, `findBy()` or `getMany()` with the same filters and paging when the count is unnecessary.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "typeorm-unused-count": "off" }
}
```
