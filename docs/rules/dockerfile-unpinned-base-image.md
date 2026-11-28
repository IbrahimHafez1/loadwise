---
id: dockerfile-unpinned-base-image
title: dockerfile-unpinned-base-image
description: "A Dockerfile uses a base image reference that can change between builds."
checker: security
group: "Rules"
impact: low
fixable: manual
---

## What it flags

A `FROM` image has no tag or uses `:latest`. A version tag is fine; a digest is best.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "dockerfile-unpinned-base-image": "off" }
}
```
