---
id: dom-xss-sink
title: dom-xss-sink
description: "Untrusted or dynamic HTML reaches innerHTML, outerHTML, insertAdjacentHTML, document.write or createContextualFragment (DOM XSS)."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

Untrusted or dynamic HTML is written to innerHTML, outerHTML, insertAdjacentHTML, document.write or createContextualFragment, which allows DOM-based XSS.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "dom-xss-sink": "off" }
}
```
