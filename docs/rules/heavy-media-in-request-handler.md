---
id: heavy-media-in-request-handler
title: heavy-media-in-request-handler
description: "Heavy image (sharp) or PDF rendering runs directly inside an HTTP request handler."
checker: performance
group: "Source checks"
impact: medium
fixable: manual
---

## What it flags

`sharp` image processing, Puppeteer `page.pdf()` or `html-pdf` rendering runs inside a request handler.

## How to review or fix

Move it to a job queue or worker thread. Contextual, because offloading changes the API.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "heavy-media-in-request-handler": "off" }
}
```
