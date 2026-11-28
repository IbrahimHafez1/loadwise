---
id: long-parameter-list
title: long-parameter-list
description: "A function takes more than 5 positional parameters."
checker: maintainability
group: "What gets checked"
impact: low
fixable: inline
---

## What it flags

A function with a body takes more than 5 positional parameters. A destructured object counts as one. Constructors with decorators or parameter properties (dependency injection lists) and parameters with decorators (`@Body()`, `@Param()`) are not counted.

## How to review or fix

Override with `limits.longParameterCount`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "long-parameter-list": "off" }
}
```
