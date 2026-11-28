---
id: dockerfile-add-remote-url
title: dockerfile-add-remote-url
description: "A Dockerfile ADD instruction retrieves a resource from a remote URL."
checker: security
group: "Rules"
impact: medium
fixable: manual
---

## What it flags

`ADD` fetches an `http(s)` URL without a checksum. Download with curl and verify a checksum, or `COPY` a local file.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "dockerfile-add-remote-url": "off" }
}
```
