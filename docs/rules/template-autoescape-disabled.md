---
id: template-autoescape-disabled
title: template-autoescape-disabled
description: "A template engine is configured to render values without HTML escaping."
checker: security
group: "Rules"
impact: medium
fixable: inline
---

## What it flags

`swig.setDefaults`, `nunjucks.configure` or `new nunjucks.Environment` sets `autoescape: false`, or Handlebars `compile`/`precompile` sets `noEscape: true`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "template-autoescape-disabled": "off" }
}
```
