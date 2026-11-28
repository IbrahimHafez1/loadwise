---
id: next-server-env-in-client
title: next-server-env-in-client
description: "A 'use client' file reads a process.env variable without the NEXT_PUBLIC_ prefix, so it is unavailable in the browser by default."
checker: reliability
group: "Source rules"
impact: high
fixable: manual
---

## What it flags

A file starting with `'use client'` reads `process.env.X` where `X` does not start with `NEXT_PUBLIC_` (`NODE_ENV` is exempt), so the value is `undefined` in the browser. Reads inside a `typeof window === 'undefined'` branch are not reported.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "next-server-env-in-client": "off" }
}
```
