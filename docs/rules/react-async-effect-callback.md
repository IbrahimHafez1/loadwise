---
id: react-async-effect-callback
title: react-async-effect-callback
description: "An async function is passed to useEffect, so its promise is treated as the cleanup function and its errors go unhandled."
checker: reliability
group: "Source rules"
impact: medium
fixable: manual
---

## What it flags

`useEffect(async () => ...)`: the promise the callback returns is treated as the cleanup function, so React warns, nothing is cleaned up and a rejection is unhandled.

## How to review or fix

Declare an async function inside the effect and call it.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "react-async-effect-callback": "off" }
}
```
