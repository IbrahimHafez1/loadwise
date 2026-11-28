---
id: mass-assignment
title: mass-assignment
description: "An unfiltered request body reaches a persistence operation."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

The whole request body reaches a Prisma, TypeORM, Mongoose or Sequelize write. Decorated DTO classes, schema parses and explicit field picks are clean.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "mass-assignment": "off" }
}
```
