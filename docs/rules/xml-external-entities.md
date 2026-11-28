---
id: xml-external-entities
title: xml-external-entities
description: "An XML parser allows processing of external entities."
checker: security
group: "Rules"
impact: medium
fixable: manual
---

## What it flags

`libxmljs` is asked to load entities or the DTD with `noent: true` or `dtdload: true`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "xml-external-entities": "off" }
}
```
