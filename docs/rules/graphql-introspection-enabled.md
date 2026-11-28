---
id: graphql-introspection-enabled
title: graphql-introspection-enabled
description: "A GraphQL server explicitly enables schema introspection."
checker: security
group: "Rules"
impact: medium
fixable: inline
---

## What it flags

A GraphQL server config turns on `introspection`, `playground` or `graphiql` with a literal `true`. Expressions are not judged.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "graphql-introspection-enabled": "off" }
}
```
