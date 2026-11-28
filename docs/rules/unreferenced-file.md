---
id: unreferenced-file
title: unreferenced-file
description: "A source file that nothing imports and that is not an entry point."
checker: maintainability
group: "What gets checked"
impact: low
fixable: manual
related: [unused-export]
---

## What it flags

An export no scanned file imports, and a source file nothing imports that is not an entry point. Static, type-only, `require()`, literal dynamic imports, `export … from` and `export *` count as use. An unshadowed `new Worker(new URL('./worker.ts', import.meta.url))` or `SharedWorker` counts as loading the file. A namespace import or `require()` uses the whole module. Deep imports by package name from sibling workspace members count as use of the names they import. When the scanned folder's own config has no `paths`, the aliases of an ancestor `tsconfig.json` or `jsconfig.json` that covers it resolve imports. Entry points are `package.json` `main`, `module`, `bin`, `exports` and script paths (also from a `package.json` above the scanned folder, mapped onto the scanned source), literal Node commands in GitHub Actions job steps, local script references in HTML, `nest-cli.json` entry files, `project.json` commands, `tsconfig` `files`, tests, scripts, configuration, migrations, entities, seeds, route folders (`pages/`, `routes/`, and `app/` in Next or Remix projects) and `main`/`index` files at a package root. A non-literal `import()` or `require()` makes findings contextual, project-wide when the specifier is unknown and for one folder when it starts with a relative path. Skipped in `--staged` and `--changed-since` runs, which do not see the whole project. When adopting loadwise on an existing codebase, record the current findings once with `loadwise check --write-baseline` and check with `--baseline`, so only new unused exports and files are reported.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "unreferenced-file": "off" }
}
```
