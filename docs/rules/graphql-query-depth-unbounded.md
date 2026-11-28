---
id: graphql-query-depth-unbounded
title: graphql-query-depth-unbounded
description: "A GraphQL server accepts queries of any depth."
checker: security
group: "Rules"
impact: medium
fixable: manual
---

## What it flags

An Apollo, Yoga, graphql-http, mercurius or Nest GraphQL server has no query depth or cost limit, so one deeply nested query can exhaust it. Contextual when the options are not visible or a limit library is imported elsewhere.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "graphql-query-depth-unbounded": "off" }
}
```
