---
id: browser-not-closed
title: browser-not-closed
description: "A Playwright or Puppeteer browser is not closed in a finally block, so an error leaves the process running."
checker: reliability
group: "Source rules"
impact: high
fixable: inline
---

## What it flags

A Playwright or Puppeteer browser is launched without a `close()` (or `disconnect()` for `puppeteer.connect`) in `finally`, so a failed run leaves the browser process running. Playwright test files, whose fixtures close the browser, are skipped.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "browser-not-closed": "off" }
}
```
