---
id: angular-ngfor-missing-trackby
title: angular-ngfor-missing-trackby
description: "An *ngFor has no trackBy, so a list replaced with new objects recreates the DOM of every item."
checker: performance
group: "Source checks"
impact: low
fixable: manual
---

## What it flags

An *ngFor has no trackBy, so a list replaced with new objects recreates the DOM of every item.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "angular-ngfor-missing-trackby": "off" }
}
```
