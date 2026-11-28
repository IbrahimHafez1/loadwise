---
id: vue-v-html-unsanitized
title: vue-v-html-unsanitized
description: "A Vue render function binds unsanitized dynamic HTML to innerHTML."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

A Vue render function binds unsanitized dynamic HTML to innerHTML.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "vue-v-html-unsanitized": "off" }
}
```
