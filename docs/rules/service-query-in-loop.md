---
id: service-query-in-loop
title: service-query-in-loop
description: "A loop calls a project function that runs several database operations per item."
checker: performance
group: "Source checks"
impact: high
fixable: inline
---

## What it flags

A call in a loop reaches several database operations through a project function, so the loop pays round trips for every item.

## How to review or fix

Add a batch variant. Test, seed, benchmark and script sources get a softer note.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "service-query-in-loop": "off" }
}
```
