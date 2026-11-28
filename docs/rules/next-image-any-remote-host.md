---
id: next-image-any-remote-host
title: next-image-any-remote-host
description: "A Next.js images.remotePatterns entry sets hostname '**', so the image optimizer fetches and serves any host (open proxy)."
checker: security
group: "Rules"
impact: medium
fixable: manual
---

## What it flags

A Next.js `images.remotePatterns` entry sets `hostname: '**'`, so the image optimizer fetches and serves images from any host the entry's protocol, port and pathname allow: a proxy anyone can use.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "next-image-any-remote-host": "off" }
}
```
