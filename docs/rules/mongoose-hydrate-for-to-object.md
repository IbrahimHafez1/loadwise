---
id: mongoose-hydrate-for-to-object
title: mongoose-hydrate-for-to-object
description: "A Mongoose query hydrates full Documents only to convert them immediately via .toObject() or .toJSON()."
checker: performance
group: "Source checks"
impact: medium
fixable: manual
---

## What it flags

A Mongoose `find`, `findOne` or `findById` result is only null-checked and converted with `.toObject()` or `.toJSON()`.

## How to review or fix

Append `.lean()` to skip hydration. Skipped when a schema customizes `toObject` or `toJSON`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "mongoose-hydrate-for-to-object": "off" }
}
```
