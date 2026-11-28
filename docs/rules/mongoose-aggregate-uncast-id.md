---
id: mongoose-aggregate-uncast-id
title: mongoose-aggregate-uncast-id
description: "A Mongoose aggregate $match compares _id to an uncast string instead of an ObjectId."
checker: reliability
group: "Source rules"
impact: high
fixable: manual
---

## What it flags

A Mongoose `aggregate()` `$match` compares `_id` to a plain string. Aggregation does not cast, so the stage matches nothing; wrap the value in `new Types.ObjectId(id)`. Skipped when a schema declares a String `_id`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "mongoose-aggregate-uncast-id": "off" }
}
```
