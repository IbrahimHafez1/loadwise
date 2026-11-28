---
id: python-swallowed-exception
title: python-swallowed-exception
description: "A Python except block only passes, so the failure is dropped silently."
checker: reliability
group: "Source rules"
impact: medium
fixable: manual
---

## What it flags

`except Exception` or `except BaseException` (alone or in a tuple) whose body is only `pass` or `...` makes every failure disappear.

## How to review or fix

Narrow types such as `FileNotFoundError` or `KeyError` with `pass` are accepted as deliberate.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "python-swallowed-exception": "off" }
}
```
