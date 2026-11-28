---
id: express-missing-compression
title: express-missing-compression
description: "An Express server registers no response compression middleware."
checker: performance
group: "Source checks"
impact: low
fixable: manual
---

## What it flags

An Express app calls `listen` and no project file imports `compression`. Reported as contextual: a reverse proxy may already compress responses.

## How to review or fix

Test files are skipped.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "express-missing-compression": "off" }
}
```
