---
id: json-parse-unguarded
title: json-parse-unguarded
description: "JSON.parse runs on outside input with no try/catch, so malformed input throws where it is not handled."
checker: reliability
group: "Source rules"
impact: medium
fixable: inline
---

## What it flags

`JSON.parse` of request, queue-message, file, fetch, storage or environment input outside a try/catch. Framework handlers that turn a throw into a 500, and startup parses, are contextual.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "json-parse-unguarded": "off" }
}
```
