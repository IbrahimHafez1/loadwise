---
id: large-class
title: large-class
description: "A class has more than 30 methods, accessors, constructors or function-valued fields."
checker: maintainability
group: "What gets checked"
impact: low
fixable: manual
---

## What it flags

A class has more than 30 methods, accessors, constructors or function-valued fields. Plain data properties (entities, DTOs) are not counted.

## How to review or fix

Override with `limits.largeClassMembers`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "large-class": "off" }
}
```
