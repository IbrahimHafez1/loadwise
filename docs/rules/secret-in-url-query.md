---
id: secret-in-url-query
title: secret-in-url-query
description: "A password, token or API key is passed in a URL query string."
checker: security
group: "Rules"
impact: medium
fixable: manual
---

## What it flags

A password, token or API key is read from, or sent in, a URL query string, where it ends up in access logs, browser history and Referer headers.

## How to review or fix

Send it in a header or the body. Reset, verify and invite tokens, and map or weather APIs that require a query key, are contextual.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "secret-in-url-query": "off" }
}
```
