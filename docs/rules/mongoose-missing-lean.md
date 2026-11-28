---
id: mongoose-missing-lean
title: mongoose-missing-lean
description: "A Mongoose read query is returned or serialized without .lean(), paying full Document hydration overhead."
checker: performance
group: "Source checks"
impact: medium
fixable: manual
---

## What it flags

A Mongoose `.find()`, `.findOne()`, or `.findById()` read query is returned or JSON-serialized without `.lean()`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "mongoose-missing-lean": "off" }
}
```
