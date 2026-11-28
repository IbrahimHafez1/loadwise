---
id: pool-created-per-request-or-item
title: pool-created-per-request-or-item
description: "A database, Redis, S3, OpenAI, Anthropic or Stripe client or pool is created on a per-request or per-item path."
checker: performance
group: "Source checks"
impact: critical
fixable: inline
related: [pg-unreleased-checkout]
---

## What it flags

A recognized pg, Prisma, MongoDB, Redis, S3, OpenAI, Anthropic or Stripe client/pool is created on a repeated path, or a chained pg checkout loses the client reference. Scope reuse to the right credentials and release checked-out clients.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "pool-created-per-request-or-item": "off" }
}
```
