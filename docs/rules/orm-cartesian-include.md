---
id: orm-cartesian-include
title: orm-cartesian-include
description: "One query joins two or more one-to-many relations, so the returned rows multiply."
checker: performance
group: "Source checks"
impact: high
fixable: inline
---

## What it flags

One TypeORM or Sequelize query joins two or more collection relations (`leftJoinAndSelect`, `relations`, `include`), so the rows multiply as the product of their sizes.

## How to review or fix

Load the second collection in its own query (`relationLoadStrategy: 'query'`, Sequelize `separate: true`).

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "orm-cartesian-include": "off" }
}
```
