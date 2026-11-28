---
id: client-env-secret-exposed
title: client-env-secret-exposed
description: "A secret-named env variable is read under a browser prefix (NEXT_PUBLIC_, VITE_, REACT_APP_...), so the build ships it to every visitor."
checker: security
group: "Rules"
impact: critical
fixable: manual
---

## What it flags

A secret-named env variable (`SECRET`, `PASSWORD`, `PRIVATE_KEY`, `SERVICE_ROLE`, `DATABASE_URL`) is read under a browser prefix (`NEXT_PUBLIC_`, `REACT_APP_`, `EXPO_PUBLIC_`, Vite `VITE_`, `PUBLIC_` in Astro projects only, SvelteKit public env). Publishable, anon and public keys are clean. No fix.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "client-env-secret-exposed": "off" }
}
```
