---
section: Fixed
---

The pre-commit hook no longer fails with "The command line is too long" on Windows when a commit stages hundreds of files; it now formats and lints them in batches.
