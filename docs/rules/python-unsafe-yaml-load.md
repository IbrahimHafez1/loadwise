---
id: python-unsafe-yaml-load
title: python-unsafe-yaml-load
description: "yaml.load without SafeLoader can construct arbitrary Python objects."
checker: security
group: "Polyglot source checks"
impact: high
fixable: manual
---

## What it flags

`yaml.load` without `SafeLoader` can construct arbitrary objects.

## How to review or fix

Use `yaml.safe_load`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "python-unsafe-yaml-load": "off" }
}
```
