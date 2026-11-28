---
id: pg-unreleased-checkout
title: pg-unreleased-checkout
description: "A chained pool checkout loses the client, so it is never released."
checker: performance
group: "Source checks"
impact: critical
fixable: inline
related: [pool-created-per-request-or-item]
---

## What it flags

A recognized pg, Prisma, MongoDB, Redis, S3, OpenAI, Anthropic or Stripe client/pool is created on a repeated path, or a chained pg checkout loses the client reference. Scope reuse to the right credentials and release checked-out clients.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "pg-unreleased-checkout": "off" }
}
```
