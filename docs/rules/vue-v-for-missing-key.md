---
id: vue-v-for-missing-key
title: vue-v-for-missing-key
description: "A list rendered with h() has no key prop, forcing inefficient patching."
checker: performance
group: "Source checks"
impact: low
fixable: manual
---

## What it flags

A list rendered with h() has no key prop, forcing inefficient patching.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "vue-v-for-missing-key": "off" }
}
```
