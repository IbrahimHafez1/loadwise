---
id: dockerfile-secret-in-build
title: dockerfile-secret-in-build
description: "A Dockerfile exposes a secret through a build argument or environment variable."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

An `ARG` or `ENV` with a secret-looking name has a literal default, or `COPY`/`ADD` puts an env file or private key into the image.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "dockerfile-secret-in-build": "off" }
}
```
