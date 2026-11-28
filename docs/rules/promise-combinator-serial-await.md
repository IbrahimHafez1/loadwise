---
id: promise-combinator-serial-await
title: promise-combinator-serial-await
description: "Promise.all receives calls that were already awaited one by one."
checker: performance
group: "Async work and sorting"
impact: medium
fixable: inline
---

## What it flags

A built-in `Promise.all` or `Promise.allSettled` receives an array of two or more already-awaited calls with known promise types. Starting them together changes which calls run after a failure. With `allSettled`, it also changes how rejections are returned.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "promise-combinator-serial-await": "off" }
}
```
