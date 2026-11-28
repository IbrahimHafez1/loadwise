---
id: migration-unparsed
title: migration-unparsed
description: "A migration statement could not be parsed and needs a manual review."
checker: reliability
group: "Migration safety"
impact: low
fixable: manual
---

## What it flags

A statement the checker could not read.

## How to review or fix

Review it by hand.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "migration-unparsed": "off" }
}
```
