---
id: node-event-listener-leak
title: node-event-listener-leak
description: "An event listener is registered inside a repeated or per-request context without matching cleanup."
checker: performance
group: "Source checks"
impact: high
fixable: manual
---

## What it flags

`.on()`, `.addListener()`, or `.addEventListener()` is registered in a request handler, loop, or lifecycle hook without cleanup.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "node-event-listener-leak": "off" }
}
```
