---
id: check-then-update-race
title: check-then-update-race
description: "A Mongoose or Sequelize document's numeric field is read, changed in JavaScript and saved without a transaction, losing concurrent updates."
checker: reliability
group: "Source rules"
impact: high
fixable: manual
---

## What it flags

A Mongoose or Sequelize document's numeric field is read, changed in JavaScript and saved without a transaction, losing concurrent updates.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "check-then-update-race": "off" }
}
```
