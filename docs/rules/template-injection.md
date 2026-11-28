---
id: template-injection
title: template-injection
description: "Request data is interpreted as template source rather than a template value."
checker: security
group: "Rules"
impact: critical
fixable: manual
---

## What it flags

Request data is the template text of `ejs`, `pug`, `handlebars`, `nunjucks`, `mustache` or lodash `template`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "template-injection": "off" }
}
```
