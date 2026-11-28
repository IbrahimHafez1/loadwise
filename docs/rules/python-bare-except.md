---
id: python-bare-except
title: python-bare-except
description: "A bare except also catches SystemExit and KeyboardInterrupt, hiding shutdowns and bugs."
checker: reliability
group: "Source rules"
impact: medium
fixable: manual
---

## What it flags

`except:` with no exception type also catches `SystemExit` and `KeyboardInterrupt`. Name the exceptions the block handles. A block that ends in a bare `raise` is accepted. Reported by `loadwise rel polyglot`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "python-bare-except": "off" }
}
```
