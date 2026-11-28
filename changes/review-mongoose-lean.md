---
section: Changed
---

The `mongoose-hydrate-for-to-object` fix, which appends `.lean()`, now requires review: `--yes` no longer applies it without asking, because a lean result skips schema defaults, getters and virtuals.
