---
id: jsx-javascript-url
title: jsx-javascript-url
description: "In React 18 and older or Preact, a URL search parameter or location hash starts a JSX href, action or iframe src (javascript: XSS)."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

A URL search parameter, router query, location hash, form field or `postMessage` payload starts a JSX `href`, `action`, `formAction` or iframe `src`, so a `javascript:` URL runs script. Only React 18 and older or Preact, read from the nearest package.json; silent for React 19, which blocks these URLs, and when the version cannot be read. Constant prefixes, props and fetched data are not reported.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "jsx-javascript-url": "off" }
}
```
