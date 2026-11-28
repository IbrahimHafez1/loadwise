---
id: angular-subscribe-without-cleanup
title: angular-subscribe-without-cleanup
description: "An RxJS subscription in a component has no completing operator or ngOnDestroy unsubscribe and keeps running after destruction."
checker: performance
group: "Source checks"
impact: medium
fixable: manual
---

## What it flags

An RxJS subscription in a component has no completing operator or ngOnDestroy unsubscribe and keeps running after destruction.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "angular-subscribe-without-cleanup": "off" }
}
```
