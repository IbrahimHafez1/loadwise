# Changelog fragments

Each pull request adds one file here, such as `changes/new-rule-name.md`, instead of editing `CHANGELOG.md`, so open pull requests do not conflict over the same lines. `npm run changelog` folds every fragment into `[Unreleased]` and deletes it; maintainers run it at release time.

```md
---
section: Added
---

Security rule `example-rule` flags a thing, so that something. No fix: a human decides.
```

- `section` is one of the Keep a Changelog sections: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` or `Security`.
- The body is the entry text, written the way a `CHANGELOG.md` bullet is, without the leading `- `.
- For several entries, write each as a `- ` bullet. They all go under the one `section`; use a second file for another section.
- The slug is short and kebab-case. This file is ignored.
