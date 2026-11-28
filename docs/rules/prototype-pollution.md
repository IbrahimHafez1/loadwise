---
id: prototype-pollution
title: prototype-pollution
description: "Request data can supply keys to a write or merge that can modify an object prototype."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

A request-controlled key is written through a nested path, or the whole request goes to lodash `merge`, `defaultsDeep`, a path `set` or an unguarded local deep merge.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "prototype-pollution": "off" }
}
```
