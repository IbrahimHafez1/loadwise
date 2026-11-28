---
id: committed-secret
title: committed-secret
description: "A tracked file contains a value that appears to be a credential."
checker: security
group: "Rules"
impact: critical
fixable: manual
---

## What it flags

A tracked file holds a credential: a non-placeholder value for a secret-looking key in a tracked `.env` file, or a high-confidence token format (AWS, GitHub, Slack, Stripe live, Google API key, private key block) in any tracked text file. Ignored `.env` files are never read, and the message shows only the key and a four-character prefix.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "committed-secret": "off" }
}
```
