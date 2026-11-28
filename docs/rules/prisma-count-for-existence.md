---
id: prisma-count-for-existence
title: prisma-count-for-existence
description: "A Prisma query counts all matches only to check whether any row exists."
checker: performance
group: "Async work and sorting"
impact: medium
fixable: inline
---

## What it flags

An awaited numeric Prisma `count()` with no options or only `where` is used solely as a zero-or-nonzero test.

## How to review or fix

Read one row with the same filter and a small projection when only existence matters.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "prisma-count-for-existence": "off" }
}
```
